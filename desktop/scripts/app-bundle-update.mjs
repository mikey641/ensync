/**
 * Shared incremental-update logic for the installed /Applications/Ensync.app.
 *
 * Copies changed host backend files and rebuilt UI assets directly into the
 * existing app bundle. Extracted from update-app.mjs so both the manual
 * one-shot updater and the continuous-update service can call it without
 * duplicating the file-copy, hash-compare, kill, or launch logic.
 *
 * The update never touches native binaries, code-signing, or notarization:
 * it overlays only interpreted source (host .mjs files and built UI assets)
 * into the Resources directory of an already-installed signed app. The
 * public release path (signed tags → release feed) stays completely separate.
 */
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, rm, mkdir, copyFile, access, symlink } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const APP_BUNDLE = '/Applications/Ensync.app'
export const RESOURCES = join(APP_BUNDLE, 'Contents', 'Resources')
export const HOST_DEST = join(RESOURCES, 'host')
export const UI_DEST = join(RESOURCES, 'ui')
export const LANDING_JOURNAL = join(homedir(), 'Library', 'Application Support', 'Ensync', 'landing-journal.json')
export const HOST_JOB_JOURNAL = join(homedir(), 'Library', 'Application Support', 'Ensync', 'ensync-host-jobs-v1.json')
export const HOST_DAEMON_DESCRIPTOR = join(homedir(), 'Library', 'Application Support', 'Ensync', 'ensync-host-daemon-v1.json')

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const DESKTOP_ROOT = resolve(scriptDir, '..')
export const REPO_ROOT = resolve(DESKTOP_ROOT, '..')
export const HOST_SRC = join(REPO_ROOT, 'host')
export const DIST_SRC = join(REPO_ROOT, 'dist')

const TERMINAL_CHAT_JOB_STATES = new Set(['completed', 'failed', 'cancelled'])

export async function pathExists(path) {
  try { await access(path); return true } catch { return false }
}

function journalPayload(document) {
  return typeof document?.payload === 'string'
    ? JSON.parse(document.payload)
    : document?.payload
}

/**
 * A continuous update may restart the installed shell only when no landing
 * train is queued or integrating. Retry records are durable and terminal for
 * the current attempt, so they do not keep an update waiting indefinitely.
 * An existing unreadable journal fails closed because idle cannot be proven.
 */
export async function hasActiveLanding({ journalPath = LANDING_JOURNAL } = {}) {
  try {
    const payload = journalPayload(JSON.parse(await readFile(journalPath, 'utf8')))
    if (!Array.isArray(payload?.items)) return true
    return payload.items.some((item) => item?.state === 'queued' || item?.state === 'integrating')
  } catch (error) {
    return error?.code !== 'ENOENT'
  }
}

/**
 * A running chat job keeps the detached Host alive on the code it loaded, so
 * installing then would pair a newer UI with an older Host. Like the landing
 * guard, an existing unreadable journal fails closed.
 */
export async function hasRunningChatJobs({ journalPath = HOST_JOB_JOURNAL } = {}) {
  try {
    const payload = journalPayload(JSON.parse(await readFile(journalPath, 'utf8')))
    if (!Array.isArray(payload?.jobs)) return true
    return payload.jobs.some((job) => !TERMINAL_CHAT_JOB_STATES.has(job?.state))
  } catch (error) {
    return error?.code !== 'ENOENT'
  }
}

export async function hashFile(path) {
  try {
    const data = await readFile(path)
    return createHash('sha256').update(data).digest('hex')
  } catch { return null }
}

export async function copyIfChanged(src, dest) {
  const [srcHash, destHash] = await Promise.all([hashFile(src), hashFile(dest)])
  if (srcHash && destHash && srcHash === destHash) return false
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
  return true
}

/**
 * Copy every non-test .mjs host file, skipping dev.mjs and *.test.mjs.
 * Returns the list of changed file names.
 */
export async function updateHostFiles({ src = HOST_SRC, dest = HOST_DEST } = {}) {
  const entries = await readdir(src, { withFileTypes: true })
  const hostFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .filter((e) => !e.name.endsWith('.test.mjs'))
    .filter((e) => e.name !== 'dev.mjs')
    .map((e) => e.name)

  const changed = []
  for (const name of hostFiles) {
    if (await copyIfChanged(join(src, name), join(dest, name))) {
      changed.push(`host/${name}`)
    }
  }
  return changed
}

/** Build the renderer in `repoRoot`, which may be an exported commit. */
export async function buildUi({ repoRoot = REPO_ROOT } = {}) {
  await execFile('npm', ['run', 'build'], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 })
}

/**
 * Rebuild UI from source, then copy dist/ into the app bundle.
 * Returns the list of changed file names.
 */
export async function updateUiFiles({
  build = true,
  src = DIST_SRC,
  dest = UI_DEST,
  repoRoot = REPO_ROOT,
} = {}) {
  if (build) await buildUi({ repoRoot })

  const destAssets = join(dest, 'assets')
  await mkdir(destAssets, { recursive: true })
  const assetNames = (await readdir(join(src, 'assets'), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)

  // New assets land before index.html points at them, and only assets the new
  // build no longer ships are removed. Unchanged files are left in place, so an
  // identical build reports nothing and never restarts the app.
  const changed = []
  for (const name of assetNames) {
    if (await copyIfChanged(join(src, 'assets', name), join(destAssets, name))) {
      changed.push(`ui/assets/${name}`)
    }
  }

  if (await copyIfChanged(join(src, 'index.html'), join(dest, 'index.html'))) {
    changed.push('ui/index.html')
  }

  const shipped = new Set(assetNames)
  for (const entry of await readdir(destAssets, { withFileTypes: true })) {
    if (shipped.has(entry.name)) continue
    await rm(join(destAssets, entry.name), { recursive: true, force: true })
    changed.push(`ui/assets/${entry.name}`)
  }

  return changed
}

export function appShellProcessPattern(appBundle = APP_BUNDLE) {
  const executable = join(appBundle, 'Contents', 'MacOS', 'Ensync')
  return `^${executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
}

export async function isAppShellRunning(appBundle = APP_BUNDLE) {
  try {
    await execFile('pgrep', ['-f', appShellProcessPattern(appBundle)])
    return true
  } catch {
    return false
  }
}

export async function killApp(appBundle = APP_BUNDLE) {
  try {
    // The detached Host uses the same executable with the bootstrap path as an
    // argument. Match only the argument-free Electron shell so a UI relaunch
    // can never terminate an in-flight Host job or landing resolver.
    await execFile('pkill', ['-f', appShellProcessPattern(appBundle)], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 1500))
  } catch { /* not running */ }
}

export async function launchApp(appBundle = APP_BUNDLE) {
  try {
    await execFile('open', [appBundle])
    return true
  } catch {
    return false
  }
}

export async function readHostDescriptor({ descriptorPath = HOST_DAEMON_DESCRIPTOR } = {}) {
  try {
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
    if (!Number.isInteger(descriptor?.pid) || !Number.isInteger(descriptor?.port)) return null
    if (typeof descriptor.token !== 'string' || !descriptor.token) return null
    return descriptor
  } catch {
    return null
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Resolves true once `pid` has exited, or false if it is still alive at the deadline. */
export async function waitForProcessExit(pid, { timeoutMs = 30_000, intervalMs = 250, isAlive = processIsAlive } = {}) {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return true
}

/**
 * A connected phone broker keeps the detached Host busy for as long as it stays
 * connected, so the Host could not switch to new code. Its status sits behind a
 * shell lease: the updater claims a lease of its own and releases it at once,
 * which never evicts the app's lease. A Host that is not answering, that
 * predates the broker, or that has no signed-in account (the broker cannot run
 * without one) has nothing to wait for.
 */
export async function brokerKeepsHostBusy({ descriptorPath = HOST_DAEMON_DESCRIPTOR, fetchImpl = globalThis.fetch } = {}) {
  const descriptor = await readHostDescriptor({ descriptorPath })
  if (!descriptor) return false
  const base = `http://127.0.0.1:${descriptor.port}`
  const authorization = `Bearer ${descriptor.token}`
  const ownerId = `continuous_update_${randomUUID().replaceAll('-', '')}`
  const lease = (path) => fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ ownerId }),
    signal: AbortSignal.timeout(5_000),
  })

  try {
    if (!(await lease('/api/daemon/claim')).ok) return false
  } catch {
    return false
  }
  try {
    const response = await fetchImpl(`${base}/api/remote/broker/status`, {
      headers: { authorization, 'x-ensync-owner': ownerId },
      signal: AbortSignal.timeout(5_000),
    })
    if (response.status === 404) return false
    if (response.status === 401) {
      const refusal = await response.json().catch(() => null)
      return refusal?.code !== 'sync_login_required'
    }
    if (!response.ok) return true
    return (await response.json())?.running === true
  } catch {
    return true
  } finally {
    await lease('/api/daemon/release').catch(() => {})
  }
}

/**
 * Read the current HEAD commit of the repository's main branch.
 * Returns null if main does not exist or git is unavailable.
 */
export async function readMainCommit({ repoRoot = REPO_ROOT } = {}) {
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'main'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

function exited(child, name) {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', (code, signal) => {
      if (code === 0) resolveExit()
      else rejectExit(new Error(`${name} exited with ${signal ?? `code ${code}`}.`))
    })
  })
}

/**
 * Materialize one exact commit for installation. The shared checkout is never
 * the source: other sessions keep uncommitted edits there, and the installed
 * app must run only landed work. The export borrows the checkout's
 * node_modules so the UI can be built from it.
 */
export async function exportCommit({ repoRoot = REPO_ROOT, commit, destination }) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('exportCommit needs a full commit SHA.')
  }
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  const archive = spawn('git', ['archive', '--format=tar', commit], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] })
  const extract = spawn('tar', ['-x', '-f', '-', '-C', destination], { stdio: ['pipe', 'ignore', 'inherit'] })
  extract.stdin.on('error', () => { /* tar's exit status reports the failure */ })
  archive.stdout.pipe(extract.stdin)
  await Promise.all([exited(archive, 'git archive'), exited(extract, 'tar')])
  if (await pathExists(join(repoRoot, 'node_modules'))) {
    await symlink(join(repoRoot, 'node_modules'), join(destination, 'node_modules'), 'dir')
  }
  return destination
}

/**
 * Run one full incremental update cycle: rebuild UI, copy changed host and UI
 * files into the installed app bundle, optionally kill and relaunch.
 *
 * Returns { changed: string[], total: number, relaunched: boolean, deferred: boolean }.
 */
export async function performIncrementalUpdate({
  rebuildUi = true,
  buildUi: runUiBuild = true,
  killAndRelaunch = true,
  appBundle = APP_BUNDLE,
  hostSrc = HOST_SRC,
  hostDest = HOST_DEST,
  distSrc = DIST_SRC,
  uiDest = UI_DEST,
  repoRoot = REPO_ROOT,
  landingJournalPath = LANDING_JOURNAL,
} = {}) {
  if (!await pathExists(appBundle)) {
    throw new Error(`${appBundle} not found. Build and install the app first.`)
  }
  // Keep the guard in the shared mutation primitive: manual and one-shot
  // update entry points call this function without going through the poller.
  if (await hasActiveLanding({ journalPath: landingJournalPath })) {
    return { changed: [], total: 0, relaunched: false, deferred: true }
  }

  const changed = []

  const hostChanged = await updateHostFiles({ src: hostSrc, dest: hostDest })
  changed.push(...hostChanged)

  if (rebuildUi) {
    const uiChanged = await updateUiFiles({ build: runUiBuild, src: distSrc, dest: uiDest, repoRoot })
    changed.push(...uiChanged)
  }

  let relaunched = false
  if (killAndRelaunch && changed.length > 0) {
    // Close the build-time race where landing begins after the first check.
    // Cached modules keep the current Host stable; it can retire once idle.
    if (await hasActiveLanding({ journalPath: landingJournalPath })) {
      return { changed, total: changed.length, relaunched: false, deferred: true }
    }
    await killApp(appBundle)
    relaunched = await launchApp(appBundle)
  }

  return { changed, total: changed.length, relaunched, deferred: false }
}

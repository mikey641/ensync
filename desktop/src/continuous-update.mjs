/**
 * In-process continuous-update poller for the Electron main process.
 *
 * Starts automatically when the app launches. Polls the repository's main
 * branch for new commits, rebuilds the UI, copies changed host and UI files
 * into the installed /Applications/Ensync.app bundle, and relaunches the app
 * cleanly using app.relaunch() + app.exit().
 *
 * The poller runs only when the build channel is 'dev' — public beta/stable
 * releases never overlay source. The repo root is read from the
 * ENSYNC_REPO_ROOT environment variable or discovered by walking up from
 * the app's location.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, mkdir, copyFile, access, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const POLL_INTERVAL_MS = 15_000
const STATE_FILE = join(homedir(), '.ensync', 'continuous-update-state.json')

const APP_BUNDLE = '/Applications/Ensync.app'
const RESOURCES = join(APP_BUNDLE, 'Contents', 'Resources')
const HOST_DEST = join(RESOURCES, 'host')
const UI_DEST = join(RESOURCES, 'ui')

function resolveRepoRoot() {
  if (process.env.ENSYNC_REPO_ROOT) return process.env.ENSYNC_REPO_ROOT
  // Walk up from the app's resources path to find a git repo
  let dir = dirname(RESOURCES)
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fall back to the common dev location
  return join(homedir(), 'dev', 'ensync')
}

async function pathExists(path) {
  try { await access(path); return true } catch { return false }
}

async function hashFile(path) {
  try {
    const data = await readFile(path)
    return createHash('sha256').update(data).digest('hex')
  } catch { return null }
}

async function copyIfChanged(src, dest) {
  const [srcHash, destHash] = await Promise.all([hashFile(src), hashFile(dest)])
  if (srcHash && destHash && srcHash === destHash) return false
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
  return true
}

async function updateHostFiles(src, dest) {
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

async function updateUiFiles(src, dest) {
  const destAssets = join(dest, 'assets')
  try { await rm(destAssets, { recursive: true }) } catch { /* nothing to wipe */ }
  await mkdir(destAssets, { recursive: true })

  const changed = []
  if (await copyIfChanged(join(src, 'index.html'), join(dest, 'index.html'))) {
    changed.push('ui/index.html')
  }

  const assetEntries = await readdir(join(src, 'assets'), { withFileTypes: true })
  for (const entry of assetEntries) {
    if (!entry.isFile()) continue
    if (await copyIfChanged(join(src, 'assets', entry.name), join(dest, 'assets', entry.name))) {
      changed.push(`ui/assets/${entry.name}`)
    }
  }
  return changed
}

async function readMainCommit(repoRoot) {
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

async function loadLastSeenCommit() {
  try {
    const data = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    return typeof data.lastSeenCommit === 'string' ? data.lastSeenCommit : null
  } catch {
    return null
  }
}

async function saveLastSeenCommit(commit) {
  await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 })
  const staging = `${STATE_FILE}.staging`
  await writeFile(staging, JSON.stringify({ lastSeenCommit: commit, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  const { rename } = await import('node:fs/promises')
  await rename(staging, STATE_FILE)
}

function log(message) {
  console.log(`[continuous-update] ${new Date().toISOString()} ${message}`)
}

/**
 * Starts the continuous-update poller. Returns a stop function.
 *
 * Runs only when the build channel is 'dev' — public releases never overlay
 * source into the app bundle.
 */
export function startContinuousUpdatePoller({ app }) {
  // Only run in dev builds. In a packaged public release (beta/stable),
  // updates flow through the signed-tag release feed, not source overlays.
  // The installed dev app is packaged (has an asar) but its build-info
  // channel is 'dev', so we check that instead of app.isPackaged.
  let isDevBuild = false
  try {
    const buildInfo = readBuildInfo()
    isDevBuild = buildInfo?.channel === 'dev'
  } catch { /* not available */ }
  if (!isDevBuild) return () => {}

  const repoRoot = resolveRepoRoot()
  const hostSrc = join(repoRoot, 'host')
  const distSrc = join(repoRoot, 'dist')

  let timer = null
  let checking = false
  let firstCheck = true

  const check = async () => {
    if (checking) return
    checking = true
    try {
      if (!await pathExists(APP_BUNDLE)) return

      const currentCommit = await readMainCommit(repoRoot)
      if (!currentCommit) return

      const lastSeen = await loadLastSeenCommit()

      if (firstCheck) {
        firstCheck = false
        if (!lastSeen) {
          log(`First start; recording main ${currentCommit.slice(0, 12)} without rebuilding.`)
          await saveLastSeenCommit(currentCommit)
        }
        return
      }

      if (lastSeen === currentCommit) return

      log(`main advanced to ${currentCommit.slice(0, 12)}; rebuilding…`)

      try {
        // Rebuild UI
        await execFile('npm', ['run', 'build'], {
          cwd: repoRoot,
          stdio: 'inherit',
          timeout: 120_000,
        })

        // Copy changed host files
        const hostChanged = await updateHostFiles(hostSrc, HOST_DEST)

        // Copy changed UI files
        const uiChanged = await updateUiFiles(distSrc, UI_DEST)

        const total = hostChanged.length + uiChanged.length
        if (total === 0) {
          log('No files changed after rebuild.')
        } else {
          for (const file of [...hostChanged, ...uiChanged]) log(`  updated ${file}`)
          log(`${total} file(s) updated.`)
        }

        await saveLastSeenCommit(currentCommit)

        // Relaunch the app cleanly with the new files.
        if (total > 0) {
          log('Relaunching app with updated files…')
          app.relaunch()
          app.exit(0)
        }
      } catch (error) {
        log(`Update failed: ${error instanceof Error ? error.message : error}`)
        await saveLastSeenCommit(currentCommit)
      }
    } finally {
      checking = false
    }
  }

  // Delay the first check so the app finishes startup.
  timer = setTimeout(check, 10_000)
  // Poll on an interval after the first check.
  const interval = setInterval(() => { void check() }, POLL_INTERVAL_MS)

  log(`Polling main every ${POLL_INTERVAL_MS}ms (repo: ${repoRoot}).`)

  return () => {
    if (timer) { clearTimeout(timer); timer = null }
    clearInterval(interval)
    log('Stopped.')
  }
}

function readBuildInfo() {
  try {
    const raw = readFileSync(join(process.resourcesPath, 'build-info.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

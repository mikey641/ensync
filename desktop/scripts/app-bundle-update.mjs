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
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, mkdir, copyFile, access } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const APP_BUNDLE = '/Applications/Ensync.app'
export const RESOURCES = join(APP_BUNDLE, 'Contents', 'Resources')
export const HOST_DEST = join(RESOURCES, 'host')
export const UI_DEST = join(RESOURCES, 'ui')

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const DESKTOP_ROOT = resolve(scriptDir, '..')
export const REPO_ROOT = resolve(DESKTOP_ROOT, '..')
export const HOST_SRC = join(REPO_ROOT, 'host')
export const DIST_SRC = join(REPO_ROOT, 'dist')

export async function pathExists(path) {
  try { await access(path); return true } catch { return false }
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
  if (build) {
    await execFile('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' })
  }

  const destAssets = join(dest, 'assets')
  try { await rm(destAssets, { recursive: true }) } catch { /* nothing to wipe on a first install */ }
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

export async function killApp() {
  try {
    await execFile('pkill', ['-f', 'Ensync'], { stdio: 'ignore' })
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

/**
 * Run one full incremental update cycle: rebuild UI, copy changed host and UI
 * files into the installed app bundle, optionally kill and relaunch.
 *
 * Returns { changed: string[], total: number, relaunched: boolean }.
 */
export async function performIncrementalUpdate({
  rebuildUi = true,
  killAndRelaunch = true,
  appBundle = APP_BUNDLE,
  hostSrc = HOST_SRC,
  hostDest = HOST_DEST,
  distSrc = DIST_SRC,
  uiDest = UI_DEST,
  repoRoot = REPO_ROOT,
} = {}) {
  if (!await pathExists(appBundle)) {
    throw new Error(`${appBundle} not found. Build and install the app first.`)
  }

  const changed = []

  const hostChanged = await updateHostFiles({ src: hostSrc, dest: hostDest })
  changed.push(...hostChanged)

  if (rebuildUi) {
    const uiChanged = await updateUiFiles({ build: true, src: distSrc, dest: uiDest, repoRoot })
    changed.push(...uiChanged)
  }

  let relaunched = false
  if (killAndRelaunch && changed.length > 0) {
    await killApp()
    relaunched = await launchApp(appBundle)
  }

  return { changed, total: changed.length, relaunched }
}

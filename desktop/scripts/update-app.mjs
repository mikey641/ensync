/**
 * Incremental update of the installed /Applications/Ensync.app.
 *
 * Copies changed host backend files and (optionally) rebuilt UI assets
 * directly into the existing app bundle, then relaunches the app.
 * This avoids a full electron-builder repackage for every code change.
 *
 * Usage:
 *   node scripts/update-app.mjs            # update host + rebuild UI
 *   node scripts/update-app.mjs --host-only # skip UI rebuild, host files only
 */
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, mkdir, copyFile, access } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const APP_BUNDLE = '/Applications/Ensync.app'
const RESOURCES = join(APP_BUNDLE, 'Contents', 'Resources')
const HOST_DEST = join(RESOURCES, 'host')
const UI_DEST = join(RESOURCES, 'ui')

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDir, '..')
const repoRoot = resolve(desktopRoot, '..')
const HOST_SRC = join(repoRoot, 'host')
const DIST_SRC = join(repoRoot, 'dist')

const HOST_ONLY = process.argv.includes('--host-only')

async function exists(path) {
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
  if (srcHash && destHash && srcHash === destHash) return false // unchanged
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
  return true // updated
}

/** Copy every non-test .mjs host file, skipping dev.mjs and *.test.mjs. */
async function updateHostFiles() {
  const entries = await readdir(HOST_SRC, { withFileTypes: true })
  const hostFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .filter((e) => !e.name.endsWith('.test.mjs'))
    .filter((e) => e.name !== 'dev.mjs')
    .map((e) => e.name)

  let updated = 0
  for (const name of hostFiles) {
    const changed = await copyIfChanged(join(HOST_SRC, name), join(HOST_DEST, name))
    if (changed) {
      updated++
      console.log(`  host/${name}`)
    }
  }
  return updated
}

/** Rebuild UI from source, then copy dist/ into the app bundle. */
async function updateUiFiles() {
  if (HOST_ONLY) {
    console.log('Skipping UI rebuild (--host-only)')
    return 0
  }

  console.log('Building UI...')
  try {
    await execFile('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' })
  } catch (error) {
    console.error('UI build failed:', error.message)
    return 0
  }

  // Wipe old assets to avoid stale hashed filenames accumulating.
  const destAssets = join(UI_DEST, 'assets')
  try { await rm(destAssets, { recursive: true }) } catch { /* nothing to wipe on a first install */ }
  await mkdir(destAssets, { recursive: true })

  let updated = 0

  // Copy index.html
  if (await copyIfChanged(join(DIST_SRC, 'index.html'), join(UI_DEST, 'index.html'))) {
    updated++
    console.log('  ui/index.html')
  }

  // Copy assets/
  const assetEntries = await readdir(join(DIST_SRC, 'assets'), { withFileTypes: true })
  for (const entry of assetEntries) {
    if (!entry.isFile()) continue
    const changed = await copyIfChanged(
      join(DIST_SRC, 'assets', entry.name),
      join(UI_DEST, 'assets', entry.name),
    )
    if (changed) {
      updated++
      console.log(`  ui/assets/${entry.name}`)
    }
  }

  return updated
}

async function killApp() {
  try {
    await execFile('pkill', ['-f', 'Ensync'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 1500))
  } catch { /* not running */ }
}

async function launchApp() {
  try {
    await execFile('open', [APP_BUNDLE])
    console.log(`Launched ${APP_BUNDLE}`)
  } catch (error) {
    console.error('Failed to launch app:', error.message)
  }
}

async function main() {
  if (!await exists(APP_BUNDLE)) {
    console.error(`${APP_BUNDLE} not found. Build and install the app first.`)
    process.exit(1)
  }

  console.log(`Updating ${APP_BUNDLE}...`)

  await killApp()

  console.log('Copying host files:')
  const hostUpdated = await updateHostFiles()
  if (hostUpdated === 0) console.log('  (all host files already up to date)')

  const uiUpdated = await updateUiFiles()
  if (!HOST_ONLY && uiUpdated === 0) console.log('  (all UI files already up to date)')

  const total = hostUpdated + uiUpdated
  console.log(`\n${total} file(s) updated.`)

  await launchApp()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

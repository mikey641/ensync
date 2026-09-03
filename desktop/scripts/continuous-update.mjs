/**
 * Local continuous-update service for the installed Ensync app.
 *
 * Polls the repository's main branch for new commits. When main advances,
 * the service rebuilds the UI, copies changed host and UI files into the
 * installed /Applications/Ensync.app bundle, and relaunches the app — all
 * using the same guarded incremental-update logic as the manual
 * update-app.mjs script.
 *
 * This is a dev-loop convenience, not a public release path. It overlays
 * only interpreted source (host .mjs files and built UI assets) into an
 * already-installed app. Semantic versioning, signing, notarization, and
 * the release feed stay on the signed-tag path and are never touched.
 *
 * Usage:
 *   node scripts/continuous-update.mjs                  # poll every 15s
 *   node scripts/continuous-update.mjs --interval 5000  # poll every 5s
 *   node scripts/continuous-update.mjs --once            # one check then exit
 *   node scripts/continuous-update.mjs --host-only       # skip UI rebuild
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  APP_BUNDLE,
  readMainCommit,
  performIncrementalUpdate,
  pathExists,
} from './app-bundle-update.mjs'

const DEFAULT_INTERVAL_MS = 15_000
const STATE_FILE = join(homedir(), '.ensync', 'continuous-update-state.json')
const MIN_INTERVAL_MS = 3_000

function parseArgs(argv = process.argv) {
  const intervalIndex = argv.indexOf('--interval')
  const intervalMs = intervalIndex >= 0
    ? Math.max(MIN_INTERVAL_MS, Number(argv[intervalIndex + 1]) || DEFAULT_INTERVAL_MS)
    : DEFAULT_INTERVAL_MS
  return {
    intervalMs,
    once: argv.includes('--once'),
    hostOnly: argv.includes('--host-only'),
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
  await import('node:fs/promises').then(({ rename }) => rename(staging, STATE_FILE))
}

function log(message) {
  console.log(`[continuous-update] ${new Date().toISOString()} ${message}`)
}

async function checkOnce({ hostOnly }) {
  if (!await pathExists(APP_BUNDLE)) {
    log(`${APP_BUNDLE} not found; skipping.`)
    return false
  }

  const currentCommit = await readMainCommit()
  if (!currentCommit) {
    log('Could not read main; skipping.')
    return false
  }

  const lastSeen = await loadLastSeenCommit()
  if (lastSeen === currentCommit) {
    return false
  }

  log(`main advanced to ${currentCommit.slice(0, 12)}${lastSeen ? ` (was ${lastSeen.slice(0, 12)})` : ' (first check)'}; rebuilding…`)

  try {
    const { changed, total, relaunched } = await performIncrementalUpdate({
      rebuildUi: !hostOnly,
      killAndRelaunch: true,
    })

    if (total === 0) {
      log('No files changed after rebuild.')
    } else {
      for (const file of changed) log(`  updated ${file}`)
      log(`${total} file(s) updated.`)
    }

    if (relaunched) log(`Relaunched ${APP_BUNDLE}.`)
    else if (total > 0) log('App was not running; files updated for next launch.')

    await saveLastSeenCommit(currentCommit)
    return true
  } catch (error) {
    log(`Update failed: ${error instanceof Error ? error.message : error}`)
    // Still record the commit so we don't retry the same failed update
    // every interval. The next main advance will try again.
    await saveLastSeenCommit(currentCommit)
    return false
  }
}

async function main() {
  const { intervalMs, once, hostOnly } = parseArgs()

  log(`Watching main${hostOnly ? ' (host-only)' : ''} every ${intervalMs}ms.`)

  // On first start, record the current commit without rebuilding, so the
  // service doesn't immediately kill and relaunch the app the user just
  // opened. Subsequent advances trigger the rebuild.
  const currentCommit = await readMainCommit()
  if (currentCommit) {
    const lastSeen = await loadLastSeenCommit()
    if (!lastSeen) {
      log(`First start; recording current main ${currentCommit.slice(0, 12)} without rebuilding.`)
      await saveLastSeenCommit(currentCommit)
    }
  }

  if (once) {
    await checkOnce({ hostOnly })
    return
  }

  let checking = false
  const interval = setInterval(async () => {
    if (checking) return
    checking = true
    try {
      await checkOnce({ hostOnly })
    } finally {
      checking = false
    }
  }, intervalMs)

  // Keep the process alive but allow SIGINT/SIGTERM to exit cleanly.
  process.on('SIGINT', () => {
    clearInterval(interval)
    log('Stopped.')
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    clearInterval(interval)
    log('Stopped.')
    process.exit(0)
  })
}

main().catch((error) => {
  console.error(`[continuous-update] ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})

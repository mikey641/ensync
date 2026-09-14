/**
 * Local continuous-update service for the installed Ensync app.
 *
 * Polls the repository's main branch. When main advances, the service exports
 * that exact commit, never the shared checkout: other sessions keep uncommitted
 * edits there, and the installed app must run only landed work. It rebuilds the
 * UI from the export and copies changed host and UI files into the installed
 * /Applications/Ensync.app bundle with the same guarded incremental-update
 * logic as the manual update-app.mjs script.
 *
 * An install waits, moving no file, while the detached Host is busy with a
 * queued or integrating landing, a running chat job, or a connected phone
 * broker. A busy Host keeps the code it loaded, and a reopened app reconnects
 * to any Host still running, so installing then would pair a newer UI with an
 * older Host. When files change and Ensync is open, the service closes the app
 * window, waits for the idle Host to retire, and reopens Ensync so a fresh Host
 * loads the new code.
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
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  APP_BUNDLE,
  brokerKeepsHostBusy,
  buildUi,
  exportCommit,
  hasActiveLanding,
  hasRunningChatJobs,
  isAppShellRunning,
  killApp,
  launchApp,
  pathExists,
  performIncrementalUpdate,
  readHostDescriptor,
  readMainCommit,
  waitForProcessExit,
} from './app-bundle-update.mjs'

const DEFAULT_INTERVAL_MS = 15_000
const STATE_FILE = join(homedir(), '.ensync', 'continuous-update-state.json')
const EXPORT_DIRECTORY = join(homedir(), '.ensync', 'continuous-update-checkout')
const MIN_INTERVAL_MS = 3_000
// An idle Host retires on its next lifecycle tick (at most five seconds) once
// the app's lease is gone; the bound only covers a Host that stayed busy.
const HOST_RETIRE_TIMEOUT_MS = 30_000

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
  await rename(staging, STATE_FILE)
}

function log(message) {
  console.log(`[continuous-update] ${new Date().toISOString()} ${message}`)
}

// A busy Host is re-checked every interval; say why only when the reason changes.
let lastDeferral = null
function logDeferral(commit, reason) {
  const key = `${commit} ${reason}`
  if (key === lastDeferral) return
  lastDeferral = key
  log(`main advanced to ${commit.slice(0, 12)}, but ${reason}; waiting.`)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export const defaultUpdateDependencies = Object.freeze({
  appBundle: APP_BUNDLE,
  exportDirectory: EXPORT_DIRECTORY,
  hostRetireTimeoutMs: HOST_RETIRE_TIMEOUT_MS,
  log,
  logDeferral,
  pathExists,
  readMainCommit: () => readMainCommit(),
  loadLastSeenCommit,
  saveLastSeenCommit,
  hasActiveLanding: () => hasActiveLanding(),
  hasRunningChatJobs: () => hasRunningChatJobs(),
  brokerKeepsHostBusy: () => brokerKeepsHostBusy(),
  exportCommit: ({ commit, destination }) => exportCommit({ commit, destination }),
  buildUi: ({ repoRoot }) => buildUi({ repoRoot }),
  removeExport: (directory) => rm(directory, { recursive: true, force: true }),
  performIncrementalUpdate,
  isAppShellRunning: () => isAppShellRunning(),
  readHostDescriptor: () => readHostDescriptor(),
  waitForProcessExit,
  killApp: () => killApp(),
  launchApp: () => launchApp(),
})

async function hostBusyReason(deps) {
  if (await deps.hasActiveLanding()) return 'an automatic landing is active'
  if (await deps.hasRunningChatJobs()) return 'an Ensync chat job is running'
  if (await deps.brokerKeepsHostBusy()) return 'the phone broker is connected'
  return null
}

/** One poll: install main's newest commit when the Host can take it. */
export async function runContinuousUpdateCheck({ hostOnly = false, ...overrides } = {}) {
  const deps = { ...defaultUpdateDependencies, ...overrides }
  if (!await deps.pathExists(deps.appBundle)) {
    deps.log(`${deps.appBundle} not found; skipping.`)
    return { outcome: 'skipped' }
  }
  const commit = await deps.readMainCommit()
  if (!commit) {
    deps.log('Could not read main; skipping.')
    return { outcome: 'skipped' }
  }
  if (await deps.loadLastSeenCommit() === commit) return { outcome: 'current' }

  const busy = await hostBusyReason(deps)
  if (busy) {
    deps.logDeferral(commit, busy)
    return { outcome: 'deferred', reason: busy }
  }

  deps.log(`main advanced to ${commit.slice(0, 12)}; installing that commit…`)
  let update
  try {
    const source = await deps.exportCommit({ commit, destination: deps.exportDirectory })
    if (!hostOnly) await deps.buildUi({ repoRoot: source })
    // The build takes seconds. Work that started meanwhile must not have the
    // app closed around it, so the Host is checked again before a file moves.
    const lateBusy = await hostBusyReason(deps)
    if (lateBusy) {
      deps.logDeferral(commit, lateBusy)
      return { outcome: 'deferred', reason: lateBusy }
    }
    update = await deps.performIncrementalUpdate({
      rebuildUi: !hostOnly,
      buildUi: false,
      killAndRelaunch: false,
      hostSrc: join(source, 'host'),
      distSrc: join(source, 'dist'),
      repoRoot: source,
    })
  } catch (error) {
    deps.log(`Update failed: ${errorMessage(error)}`)
    // Still record the commit so we don't retry the same failed update
    // every interval. The next main advance will try again.
    await deps.saveLastSeenCommit(commit)
    return { outcome: 'failed' }
  } finally {
    await deps.removeExport(deps.exportDirectory).catch(() => {})
  }

  if (update.deferred) {
    deps.logDeferral(commit, 'an automatic landing is active')
    return { outcome: 'deferred', reason: 'an automatic landing is active' }
  }
  if (update.total === 0) {
    deps.log(`The installed app already matches ${commit.slice(0, 12)}.`)
    await deps.saveLastSeenCommit(commit)
    return { outcome: 'unchanged' }
  }
  for (const file of update.changed) deps.log(`  updated ${file}`)
  deps.log(`${update.total} file(s) updated.`)

  if (!await deps.isAppShellRunning()) {
    // No window holds a lease, so an idle Host retires by itself and the next
    // launch loads the new code.
    deps.log('Ensync is not open; the next launch uses the new files.')
    await deps.saveLastSeenCommit(commit)
    return { outcome: 'installed', relaunched: false }
  }

  // The app reconnects to any Host still running, so the old Host must be gone
  // before Ensync reopens or the new UI would talk to the old Host code.
  const host = update.changed.some((file) => file.startsWith('host/'))
    ? await deps.readHostDescriptor()
    : null
  await deps.killApp()
  let hostRetired = null
  if (host) {
    hostRetired = await deps.waitForProcessExit(host.pid, { timeoutMs: deps.hostRetireTimeoutMs })
    deps.log(hostRetired
      ? 'The previous Ensync Host retired.'
      : 'The Ensync Host stayed busy, so it keeps its previous code until it is idle with Ensync closed.')
  }
  const relaunched = await deps.launchApp()
  deps.log(relaunched ? `Relaunched ${deps.appBundle}.` : `Could not relaunch ${deps.appBundle}.`)
  await deps.saveLastSeenCommit(commit)
  return { outcome: 'installed', relaunched, hostRetired }
}

async function main() {
  const { intervalMs, once, hostOnly } = parseArgs()

  log(`Watching main${hostOnly ? ' (host-only)' : ''} every ${intervalMs}ms.`)

  // On first start, record the current commit without rebuilding, so the
  // service doesn't immediately kill and relaunch the app the user just
  // opened. Subsequent advances trigger the rebuild.
  const currentCommit = await readMainCommit()
  if (currentCommit && !await loadLastSeenCommit()) {
    log(`First start; recording current main ${currentCommit.slice(0, 12)} without rebuilding.`)
    await saveLastSeenCommit(currentCommit)
  }

  if (once) {
    await runContinuousUpdateCheck({ hostOnly })
    return
  }

  let checking = false
  const interval = setInterval(async () => {
    if (checking) return
    checking = true
    try {
      await runContinuousUpdateCheck({ hostOnly })
    } catch (error) {
      log(`Check failed: ${errorMessage(error)}`)
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[continuous-update] ${errorMessage(error)}`)
    process.exit(1)
  })
}

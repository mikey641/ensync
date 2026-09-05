import { randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

// Keep this bootstrap dependency-free: packaged builds copy it beside the bundled
// host rather than into the Electron asar.
const HOST_READY_PREFIX = 'ENSYNC_HOST_READY:'
const token = process.env.ENSYNC_HOST_AUTH_TOKEN
const stateFile = process.env.ENSYNC_HOST_STATE_FILE
const journalFile = process.env.ENSYNC_HOST_JOB_JOURNAL_FILE
const projectIsolationRoot = process.env.ENSYNC_HOST_PROJECT_ISOLATION_ROOT
const idleShutdownMs = Number(process.env.ENSYNC_HOST_IDLE_SHUTDOWN_MS || 60_000)
const detachedMode = Boolean(token && stateFile && journalFile)

const hostEntry = process.env.ENSYNC_HOST_ENTRY
if (!hostEntry || !isAbsolute(hostEntry)) {
  throw new Error('ENSYNC_HOST_ENTRY must point to the bundled host/server.mjs file.')
}
if ([token, stateFile, journalFile].some(Boolean) && !detachedMode) {
  throw new Error('Detached Ensync Host authentication, state, and journal settings must be provided together.')
}
if (detachedMode && token.length < 32) throw new Error('ENSYNC_HOST_AUTH_TOKEN is invalid.')
if (detachedMode && !isAbsolute(stateFile)) throw new Error('ENSYNC_HOST_STATE_FILE must be absolute.')
if (detachedMode && !isAbsolute(journalFile)) throw new Error('ENSYNC_HOST_JOB_JOURNAL_FILE must be absolute.')
if (projectIsolationRoot && !isAbsolute(projectIsolationRoot)) {
  throw new Error('ENSYNC_HOST_PROJECT_ISOLATION_ROOT must be absolute.')
}
await access(hostEntry)

const [{ startEnsyncHost }, {
  DaemonLeaseService,
  hostSourceStamp,
  shouldKeepDaemonAlive,
  shouldRetireForStaleSource,
}] = await Promise.all([
  import(pathToFileURL(hostEntry).href),
  // Source and packaged builds both keep the daemon module beside server.mjs.
  import(new URL('./daemon-lifecycle.mjs', pathToFileURL(hostEntry)).href),
])
if (typeof startEnsyncHost !== 'function') {
  throw new Error('The bundled Ensync Host does not export startEnsyncHost().')
}

// Node caches these modules for the life of the process, so stamp the directory
// they were just imported from: a later build shipped over it will not match.
const hostDirectory = dirname(hostEntry)
const loadedSourceStamp = detachedMode ? await hostSourceStamp(hostDirectory) : null

const daemonLeaseService = detachedMode ? new DaemonLeaseService() : null
const instanceId = randomUUID()
const server = startEnsyncHost({
  host: '127.0.0.1',
  port: 0,
  defaultProjectPath: process.env.ENSYNC_DEFAULT_PROJECT_PATH || process.cwd(),
  authToken: detachedMode ? token : null,
  instanceId: detachedMode ? instanceId : null,
  chatJobJournalPath: detachedMode ? journalFile : null,
  projectIsolationRoot: projectIsolationRoot || undefined,
  daemonLeaseService,
})

async function writeDescriptor(port) {
  const staging = `${stateFile}.${process.pid}.staging`
  const backup = `${stateFile}.backup`
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
  await writeFile(staging, JSON.stringify({
    version: 1,
    apiVersion: 1,
    instanceId,
    pid: process.pid,
    port,
    token,
    startedAt: new Date().toISOString(),
  }), { encoding: 'utf8', mode: 0o600 })
  try { await chmod(staging, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
  try {
    const current = await readFile(stateFile, 'utf8')
    await writeFile(backup, current, { encoding: 'utf8', mode: 0o600 })
    try { await chmod(backup, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
  } catch {
    // First startup has no descriptor to preserve.
  }
  try {
    // POSIX rename replaces atomically, so readers never observe a missing
    // rendezvous file. Windows falls back while the backup remains usable.
    await rename(staging, stateFile)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
    await rm(stateFile, { force: true })
    await rename(staging, stateFile)
  }
}

async function removeOwnDescriptor() {
  try {
    const descriptor = JSON.parse(await readFile(stateFile, 'utf8'))
    if (descriptor?.instanceId === instanceId) await rm(stateFile, { force: true })
  } catch {
    // Missing/corrupt rendezvous state cannot authorize deleting another file.
  }
}

server.once('listening', async () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Ensync Host did not bind a TCP port.')
  if (detachedMode) await writeDescriptor(address.port)
  // Attached test mode can still observe readiness; detached production uses
  // the user-only rendezvous file and has no inherited stdio.
  if (process.stdout.writable) {
    process.stdout.write(`${HOST_READY_PREFIX}${JSON.stringify({ port: address.port })}\n`)
  }
})

let stopping = false
async function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  if (cleanupTimer) clearInterval(cleanupTimer)
  const forceExit = setTimeout(() => process.exit(1), 6_000)
  forceExit.unref?.()
  await server.ensyncServices.chatJobs.shutdown()
  await server.ensyncServices.deliveryCoordinator?.shutdown?.()
  await server.ensyncServices.landingCoordinator?.shutdown?.()
  await new Promise((resolve) => server.close(resolve))
  if (detachedMode) await removeOwnDescriptor()
  clearTimeout(forceExit)
  process.exit(exitCode)
}

function daemonBusy() {
  const brokerConnected = server.ensyncServices.syncBrokerHost?.status?.().running === true
  const landingActive = server.ensyncServices.landingCoordinator?.hasActiveWork?.() === true
  const deliveryActive = server.ensyncServices.deliveryCoordinator?.hasActiveWork?.() === true
  return brokerConnected || landingActive || deliveryActive || shouldKeepDaemonAlive(
    daemonLeaseService.activeCount(),
    server.ensyncServices.chatJobs.hasRunningJobs(),
  )
}

// Retiring is checked while idle instead of waiting out the idle timeout, so a
// freshly shipped build takes over on the app's next request. Re-reading the
// busy state after the stamp resolves keeps work that started meanwhile safe.
let retireCheckRunning = false
async function retireIfSourceChanged() {
  if (retireCheckRunning || stopping || !loadedSourceStamp) return
  retireCheckRunning = true
  try {
    const currentStamp = await hostSourceStamp(hostDirectory)
    if (!shouldRetireForStaleSource(loadedSourceStamp, currentStamp, daemonBusy())) return
    if (process.stderr.writable) {
      process.stderr.write('[ensync-host] retiring: bundled host code changed\n')
    }
    await stop(0)
  } finally {
    retireCheckRunning = false
  }
}

let idleSince = null
const cleanupTimer = detachedMode ? setInterval(() => {
  server.ensyncServices.chatJobs.sweep()
  if (daemonBusy()) {
    idleSince = null
    return
  }
  void retireIfSourceChanged()
  idleSince ??= Date.now()
  if (Date.now() - idleSince >= idleShutdownMs) void stop(0)
}, Math.min(5_000, Math.max(100, Math.floor(idleShutdownMs / 4)))) : null
cleanupTimer?.unref?.()

process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))
if (!detachedMode) process.on('disconnect', () => void stop(0))

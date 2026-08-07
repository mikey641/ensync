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
await access(hostEntry)

const [{ startEnsyncHost }, { DaemonLeaseService, shouldKeepDaemonAlive }] = await Promise.all([
  import(pathToFileURL(hostEntry).href),
  // Source and packaged builds both keep the daemon module beside server.mjs.
  import(new URL('./daemon-lifecycle.mjs', pathToFileURL(hostEntry)).href),
])
if (typeof startEnsyncHost !== 'function') {
  throw new Error('The bundled Ensync Host does not export startEnsyncHost().')
}

const daemonLeaseService = detachedMode ? new DaemonLeaseService() : null
const instanceId = randomUUID()
const server = startEnsyncHost({
  host: '127.0.0.1',
  port: 0,
  defaultProjectPath: process.env.ENSYNC_DEFAULT_PROJECT_PATH || process.cwd(),
  authToken: detachedMode ? token : null,
  instanceId: detachedMode ? instanceId : null,
  chatJobJournalPath: detachedMode ? journalFile : null,
  daemonLeaseService,
})

async function writeDescriptor(port) {
  const staging = `${stateFile}.${process.pid}.staging`
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
  await rm(stateFile, { force: true })
  await rename(staging, stateFile)
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
  await new Promise((resolve) => server.close(resolve))
  if (detachedMode) await removeOwnDescriptor()
  clearTimeout(forceExit)
  process.exit(exitCode)
}

let idleSince = null
const cleanupTimer = detachedMode ? setInterval(() => {
  server.ensyncServices.chatJobs.sweep()
  const idle = !shouldKeepDaemonAlive(
    daemonLeaseService.activeCount(),
    server.ensyncServices.chatJobs.hasRunningJobs(),
  )
  if (!idle) {
    idleSince = null
    return
  }
  idleSince ??= Date.now()
  if (Date.now() - idleSince >= idleShutdownMs) void stop(0)
}, Math.min(5_000, Math.max(100, Math.floor(idleShutdownMs / 4)))) : null
cleanupTimer?.unref?.()

process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))
if (!detachedMode) process.on('disconnect', () => void stop(0))

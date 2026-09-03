import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { processIsLiveSince } from './process-liveness.mjs'

const SCHEMA_VERSION = 1
const DEFAULT_POLL_MS = 250
const DEFAULT_HEARTBEAT_MS = 5_000
const DEFAULT_STALE_MS = 30_000
// `updatedAt` is a renewable heartbeat written after the owner process starts,
// so this lease needs only enough tolerance for `ps`'s one-second precision and
// modest clock jitter. Five seconds is the initial cap, bounded below a custom
// stale window and reduced by every millisecond spent past that boundary. The
// grace therefore reaches zero instead of letting an immediately recycled PID
// impersonate the retired owner indefinitely.
const PROCESS_START_TOLERANCE_CAP_MS = 5_000
const LIVE_TOKENS = new Set()

function processStartToleranceMs(staleMs, staleByMs) {
  const initial = Number.isFinite(staleMs) && staleMs > 0
    ? Math.min(PROCESS_START_TOLERANCE_CAP_MS, staleMs / 2)
    : 0
  return Math.max(0, initial - Math.max(0, staleByMs))
}

export class RepositoryLandLeaseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RepositoryLandLeaseError'
    this.code = code
    this.status = 409
  }
}

function cancelledError() {
  return new RepositoryLandLeaseError(
    'repository_land_cancelled',
    'Landing was cancelled before Ensync acquired the repository landing queue.',
  )
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError()
}

function wait(delayMs, signal) {
  throwIfCancelled(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs)
    function done() {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(cancelledError())
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

async function readOwner(ownerPath) {
  try {
    const value = JSON.parse(await readFile(ownerPath, 'utf8'))
    if (!value || typeof value !== 'object' || value.schemaVersion !== SCHEMA_VERSION
      || typeof value.token !== 'string' || value.token.length < 8 || value.token.length > 128
      || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return null
    return value
  } catch {
    return null
  }
}

async function lockIsReclaimable(lockPath, ownerPath, now, staleMs) {
  const owner = await readOwner(ownerPath)
  if (owner) {
    const recordedAtMs = Date.parse(owner.updatedAt)
    const staleByMs = now - recordedAtMs - staleMs
    const stale = staleByMs > 0
    if (!stale || LIVE_TOKENS.has(owner.token)) return false
    if (owner.pid !== process.pid
      && processIsLiveSince(owner.pid, recordedAtMs, {
        now,
        toleranceMs: processStartToleranceMs(staleMs, staleByMs),
      })) return false
    return true
  }
  try {
    const info = await stat(lockPath)
    return now - info.mtimeMs > staleMs
  } catch {
    return false
  }
}

export async function withRepositoryLandLease(commonGitDirectory, callback, options = {}) {
  if (typeof commonGitDirectory !== 'string' || !isAbsolute(commonGitDirectory)) {
    throw new TypeError('The repository landing queue requires an absolute Git common directory.')
  }
  if (typeof callback !== 'function') throw new TypeError('The repository landing queue requires a callback.')
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const now = options.now ?? Date.now
  const uuid = options.randomUUID ?? randomUUID
  const parentPath = join(commonGitDirectory, 'ensync')
  const lockPath = join(parentPath, 'repository-land.lock')
  const ownerPath = join(lockPath, 'owner.json')
  const token = uuid()
  let waited = false

  await mkdir(parentPath, { recursive: true, mode: 0o700 })
  while (true) {
    throwIfCancelled(options.signal)
    try {
      await mkdir(lockPath, { mode: 0o700 })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    if (await lockIsReclaimable(lockPath, ownerPath, now(), staleMs)) {
      const quarantine = `${lockPath}.stale-${uuid()}`
      try {
        await rename(lockPath, quarantine)
        await rm(quarantine, { recursive: true, force: true })
        continue
      } catch (error) {
        if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
      }
    }
    if (!waited) {
      waited = true
      options.onWait?.()
    }
    await wait(pollMs, options.signal)
  }

  let released = false
  let lost = null
  let pendingHeartbeat = null
  const owner = () => ({
    schemaVersion: SCHEMA_VERSION,
    token,
    pid: process.pid,
    updatedAt: new Date(now()).toISOString(),
  })
  const writeOwner = async () => {
    const temporaryPath = join(lockPath, `owner.json.tmp-${uuid()}`)
    await writeFile(temporaryPath, `${JSON.stringify(owner())}\n`, { mode: 0o600 })
    await rename(temporaryPath, ownerPath)
  }

  try {
    await writeOwner()
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true })
    throw error
  }
  LIVE_TOKENS.add(token)

  const heartbeat = setInterval(() => {
    if (released || pendingHeartbeat) return
    pendingHeartbeat = writeOwner()
      .catch((error) => {
        lost = new RepositoryLandLeaseError(
          'repository_land_lease_lost',
          `Ensync lost the repository landing lease: ${error instanceof Error ? error.message : 'unknown error'}`,
        )
      })
      .finally(() => { pendingHeartbeat = null })
  }, heartbeatMs)
  heartbeat.unref?.()

  const lease = {
    async assertHeld() {
      if (lost) throw lost
      const current = await readOwner(ownerPath)
      if (!current || current.token !== token) {
        throw new RepositoryLandLeaseError(
          'repository_land_lease_lost',
          'Ensync lost ownership of the repository landing queue before the land completed.',
        )
      }
    },
    async release() {
      if (released) return
      released = true
      clearInterval(heartbeat)
      await pendingHeartbeat?.catch(() => {})
      LIVE_TOKENS.delete(token)
      const current = await readOwner(ownerPath)
      if (!current || current.token !== token) return
      await unlink(ownerPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error
      })
      await rmdir(lockPath).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error
      })
    },
  }

  try {
    return await callback(lease)
  } finally {
    await lease.release()
  }
}

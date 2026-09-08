import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// A bundled loopback Ensync Sync service keeps single-computer account sync
// working out of the box: when no explicit ENSYNC_SYNC_SERVICE_URL is supplied,
// the desktop shell starts it on a stable loopback port and points the Host at
// it. The service is detached and never killed by the shell, so it shares the
// lifespan of the retained Host daemon instead of dying under it and leaving a
// stale account-sync URL. A later launch probes the stable URL first and reuses
// an already-healthy service. An explicit HTTPS/loopback URL always wins and
// disables this fallback.
const DEFAULT_SYNC_PORT = '43122'
const READY_STATE_FILENAME = 'ensync-sync-daemon-v1.json'
const STARTUP_TIMEOUT_MS = 10_000
const HOSTED_PWA_ORIGIN = 'https://ensync.vercel.app'

/**
 * The bundled service is loopback-only unless an operator points a local tunnel
 * at it. When one does, the hosted phone PWA needs to be an allowed browser
 * origin so its HTTPS requests can use the tunnel without opening the service
 * to arbitrary origins. Existing operator origins are preserved.
 */
export function mergeAllowedOrigins(existing) {
  const origins = (typeof existing === 'string' ? existing : '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (!origins.includes(HOSTED_PWA_ORIGIN)) origins.push(HOSTED_PWA_ORIGIN)
  return origins.join(',')
}

export function resolveLocalSyncServiceOptions({ isPackaged, resourcesPath, repositoryRoot, env = process.env }) {
  if (env.ENSYNC_SYNC_SERVICE_URL) return null
  const entryPath = isPackaged
    ? join(resourcesPath, 'sync-service', 'server.mjs')
    : join(repositoryRoot, 'sync-service', 'server.mjs')
  return {
    entryPath,
    host: env.ENSYNC_SYNC_HOST ?? '127.0.0.1',
    port: env.ENSYNC_SYNC_PORT ?? DEFAULT_SYNC_PORT,
  }
}

export async function probeLocalSyncService(url, fetchImpl = globalThis.fetch) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 750)
    const response = await fetchImpl(`${url}/v1/status`, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) return false
    const payload = await response.json().catch(() => null)
    return payload?.service === 'ensync-sync'
  } catch {
    return false
  }
}

async function readStatePort(stateFile) {
  try {
    const descriptor = JSON.parse(await readFile(stateFile, 'utf8'))
    if (Number.isInteger(descriptor?.port)) return descriptor.port
  } catch {
    // Not written yet while the detached child is still binding.
  }
  return null
}

export function startLocalSyncService(options) {
  const {
    isPackaged,
    resourcesPath,
    repositoryRoot,
    userDataPath,
    executable = process.execPath,
    env = process.env,
    spawnImpl = spawn,
    fetchImpl = globalThis.fetch,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
  } = options
  const resolved = resolveLocalSyncServiceOptions({ isPackaged, resourcesPath, repositoryRoot, env })

  if (!resolved) {
    return Promise.resolve({ url: env.ENSYNC_SYNC_SERVICE_URL, stop: async () => {} })
  }
  if (typeof spawnImpl !== 'function') {
    throw new Error('startLocalSyncService requires a spawn implementation.')
  }

  const localUrl = `http://${resolved.host}:${resolved.port}`

  return (async () => {
    // Reuse a service that is already healthy on the stable port (for example
    // one left running by a previous shell or by the development bundle).
    if (resolved.port !== '0' && await probeLocalSyncService(localUrl, fetchImpl)) {
      return { url: localUrl, stop: async () => {}, reused: true }
    }

    const stateFile = join(userDataPath, READY_STATE_FILENAME)
    const child = spawnImpl(executable, [resolved.entryPath], {
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        ENSYNC_SYNC_HOST: resolved.host,
        ENSYNC_SYNC_PORT: resolved.port,
        ENSYNC_SYNC_DATA_FILE: join(userDataPath, 'ensync-sync-data.json'),
        ENSYNC_SYNC_STATE_FILE: stateFile,
        ENSYNC_SYNC_ALLOWED_ORIGINS: mergeAllowedOrigins(env.ENSYNC_SYNC_ALLOWED_ORIGINS),
      },
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    // The shell must be able to exit without waiting on, or reaping, this
    // shared service; it is reclaimed on the next launch via the stable port.
    child.unref?.()

    return await new Promise((resolveStart) => {
      let settled = false
      let spawned = false
      const timer = setTimeout(() => settle(null), startupTimeoutMs)

      const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }

      const settle = (port) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (port === null) void stop()
        resolveStart({ url: port === null ? null : `http://${resolved.host}:${port}`, stop })
      }

      child.once('error', () => {
        spawned = true
        settle(null)
      })
      child.once('exit', () => {
        spawned = true
        settle(null)
      })
      child.once('spawn', () => {
        spawned = true
      })

      const deadline = Date.now() + startupTimeoutMs
      const poll = async () => {
        if (settled || (spawned && child.exitCode !== null)) return
        const port = await readStatePort(stateFile)
        if (port !== null) return settle(port)
        if (Date.now() >= deadline) return settle(null)
        setTimeout(() => void poll(), 50)
      }
      void poll()
    })
  })()
}

import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

export const HOST_READY_PREFIX = 'ENSYNC_HOST_READY:'
export const APP_SCHEME = 'ensync'
export const APP_HOST = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_SCHEME_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
  codeCache: true,
})

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

const DEFAULT_LEASE_HEARTBEAT_MS = 15_000
const DEFAULT_DESCRIPTOR_RETRY_MS = 15_000
const LAUNCH_LOCK_STALE_MS = 30_000

function securityHeaders(inlineScriptHashes = []) {
  const scriptSources = ["'self'", ...inlineScriptHashes.map((hash) => `'sha256-${hash}'`)]
  return {
    'Content-Security-Policy': [
    "default-src 'self'",
    "connect-src 'self'",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  }
}

function appendChunk(onLine, state, chunk) {
  state.buffer += chunk.toString('utf8')
  for (;;) {
    const newline = state.buffer.indexOf('\n')
    if (newline < 0) break
    const line = state.buffer.slice(0, newline).trimEnd()
    state.buffer = state.buffer.slice(newline + 1)
    onLine(line)
  }
}

function processExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export class HostProcessController {
  constructor(options) {
    if (!options || !isAbsolute(options.bootstrapPath) || !isAbsolute(options.hostEntryPath)) {
      throw new TypeError('Host bootstrap and entry paths must be absolute.')
    }
    this.options = options
    this.child = null
    this.port = null
    this.authToken = null
    this.heartbeatTimer = null
    this.leaseExpiresAtMs = 0
    this.leaseRefresh = null
    this.connectionRefresh = null
    this.releasing = false
    this.ownerId = options.ownerId ?? `shell_${randomUUID()}`
  }

  async start() {
    if (this.child) throw new Error('Ensync Host is already running.')
    this.releasing = false
    if (this.options.stateFilePath || this.options.journalFilePath) {
      return this.#startDetachedDaemon()
    }

    const {
      bootstrapPath,
      cwd,
      env = {},
      executable = process.execPath,
      hostEntryPath,
      spawnImpl = spawn,
      startupTimeoutMs = 20_000,
    } = this.options

    await Promise.all([access(bootstrapPath), access(hostEntryPath)])

    const childEnvironment = {
      ...process.env,
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      ENSYNC_HOST_ENTRY: hostEntryPath,
    }
    // Attached/test Hosts must never inherit another native shell's detached
    // daemon credentials. Mode is selected by controller options, not ambient
    // environment left behind by an already-running Ensync instance.
    delete childEnvironment.ENSYNC_HOST_AUTH_TOKEN
    delete childEnvironment.ENSYNC_HOST_STATE_FILE
    delete childEnvironment.ENSYNC_HOST_JOB_JOURNAL_FILE

    const child = spawnImpl(executable, [bootstrapPath], {
      cwd,
      env: childEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    return await new Promise((resolveStart, rejectStart) => {
      let settled = false
      const stdoutState = { buffer: '' }
      const stderrState = { buffer: '' }
      const diagnostics = []

      const finish = (error, port) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('error', onError)
        child.off('exit', onExit)
        if (error) {
          this.child = null
          rejectStart(error)
          return
        }
        this.port = port
        resolveStart({ port, child })
      }

      const onStdoutLine = (line) => {
        if (line.startsWith(HOST_READY_PREFIX)) {
          try {
            const message = JSON.parse(line.slice(HOST_READY_PREFIX.length))
            if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65_535) {
              throw new Error('Host returned an invalid port.')
            }
            finish(null, message.port)
          } catch (error) {
            finish(error instanceof Error ? error : new Error('Invalid host readiness message.'))
          }
          return
        }
        if (line) console.log(`[ensync-host] ${line}`)
      }
      const onStderrLine = (line) => {
        if (!line) return
        diagnostics.push(line)
        if (diagnostics.length > 8) diagnostics.shift()
        console.error(`[ensync-host] ${line}`)
      }
      const onError = (error) => finish(error)
      const onExit = (code, signal) => {
        const detail = diagnostics.length ? ` ${diagnostics.join(' ')}` : ''
        finish(new Error(`Ensync Host exited before startup (${signal ?? code ?? 'unknown'}).${detail}`))
      }

      child.stdout.on('data', (chunk) => appendChunk(onStdoutLine, stdoutState, chunk))
      child.stderr.on('data', (chunk) => appendChunk(onStderrLine, stderrState, chunk))
      child.once('error', onError)
      child.once('exit', onExit)

      const timer = setTimeout(() => {
        finish(new Error('Ensync Host did not become ready before the startup timeout.'))
        if (!processExited(child)) child.kill()
      }, startupTimeoutMs)
      timer.unref?.()
    })
  }

  async stop(timeoutMs = 5_000) {
    if (this.options.stateFilePath) return this.release()
    const child = this.child
    this.child = null
    this.port = null
    if (!child || processExited(child)) return

    await new Promise((resolveStop) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolveStop()
      }
      child.once('exit', finish)
      child.kill()
      const timer = setTimeout(() => {
        if (!processExited(child)) child.kill('SIGKILL')
        finish()
      }, timeoutMs)
      timer.unref?.()
    })
  }

  async release() {
    this.releasing = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    const port = this.port
    const authToken = this.authToken
    this.child = null
    this.port = null
    this.authToken = null
    this.leaseExpiresAtMs = 0
    this.leaseRefresh = null
    this.connectionRefresh = null
    if (!port || !authToken) return
    // Do not wait for an in-flight health retry or launch-lock acquisition.
    // Those operations are independently bounded and fence their eventual
    // claim below when `releasing` is true. Shell shutdown therefore waits at
    // most for this exact two-second release request, never for discovery.
    await this.#daemonRequest(port, authToken, '/api/daemon/release', {
      ownerId: this.ownerId,
    }).catch(() => {})
  }

  /**
   * Verify the detached Host still recognizes this native shell before the
   * renderer can submit API work. A heartbeat normally extends the current
   * lease; after sleep or a missed timer, an authenticated claim repairs the
   * expired in-memory lease without changing the Host or replaying a request.
   */
  async ensureLease({ force = false } = {}) {
    if (!this.options.stateFilePath) return null
    if (this.releasing) throw new Error('The native shell is releasing its Ensync Host lease.')
    if (!this.port || !this.authToken) throw new Error('Detached Ensync Host is not connected.')
    if (!force && this.leaseExpiresAtMs > Date.now() + 5_000) return null
    if (this.leaseRefresh) return this.leaseRefresh

    const port = this.port
    const authToken = this.authToken
    const refresh = (async () => {
      let payload = null
      if (this.leaseExpiresAtMs > Date.now()) {
        try {
          payload = await this.#daemonRequest(port, authToken, '/api/daemon/heartbeat', {
            ownerId: this.ownerId,
          })
        } catch {
          // A missed heartbeat removes the Host's in-memory lease. Re-claiming
          // the same authenticated owner is idempotent and happens before any
          // renderer request is proxied.
        }
      }
      payload ??= await this.#daemonRequest(port, authToken, '/api/daemon/claim', {
        ownerId: this.ownerId,
      })
      if (this.releasing || this.port !== port || this.authToken !== authToken) {
        // A late claim must not recreate a lease after release() already
        // returned. Drop the exact owner on the endpoint that accepted it.
        await this.#daemonRequest(port, authToken, '/api/daemon/release', {
          ownerId: this.ownerId,
        }).catch(() => {})
        if (this.releasing) throw new Error('The native shell released its Ensync Host lease.')
        return payload
      }
      const expiresAtMs = Date.parse(payload?.lease?.expiresAt ?? '')
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        throw new Error('Detached Ensync Host returned an invalid shell lease.')
      }
      this.leaseExpiresAtMs = expiresAtMs
      return payload
    })()
    this.leaseRefresh = refresh
    try {
      return await refresh
    } finally {
      if (this.leaseRefresh === refresh) this.leaseRefresh = null
    }
  }

  /**
   * Return the current authenticated Host endpoint, replacing a dead detached
   * Host first when necessary. Calls share one recovery promise so concurrent
   * windows can never start competing journal writers.
   */
  async ensureConnected({ force = false } = {}) {
    if (!this.options.stateFilePath) {
      if (!this.port) await this.start()
      return { port: this.port, authToken: this.authToken, ownerId: this.ownerId }
    }
    if (this.releasing) throw new Error('The native shell is releasing its Ensync Host lease.')

    try {
      await this.ensureLease({ force })
      return { port: this.port, authToken: this.authToken, ownerId: this.ownerId }
    } catch {
      if (this.releasing) throw new Error('The native shell is releasing its Ensync Host lease.')
      // Continue below. A dead endpoint is replaced before the renderer request
      // is proxied; a live-but-busy PID remains fenced by descriptor discovery.
    }
    if (this.connectionRefresh) return this.connectionRefresh

    const refresh = (async () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      this.child = null
      this.port = null
      this.authToken = null
      this.leaseExpiresAtMs = 0
      const connection = await this.#startDetachedDaemon()
      return {
        port: connection.port,
        authToken: this.authToken,
        ownerId: this.ownerId,
      }
    })()
    this.connectionRefresh = refresh
    try {
      return await refresh
    } finally {
      if (this.connectionRefresh === refresh) this.connectionRefresh = null
    }
  }

  async #startDetachedDaemon() {
    const {
      bootstrapPath,
      cwd,
      env = {},
      executable = process.execPath,
      hostEntryPath,
      journalFilePath,
      spawnImpl = spawn,
      startupTimeoutMs = 20_000,
      stateFilePath,
    } = this.options
    if (!isAbsolute(stateFilePath) || !isAbsolute(journalFilePath)) {
      throw new TypeError('Detached Host state and journal paths must be absolute.')
    }
    if (this.releasing) throw new Error('The native shell is releasing its Ensync Host lease.')
    await Promise.all([access(bootstrapPath), access(hostEntryPath)])
    if (this.releasing) throw new Error('The native shell is releasing its Ensync Host lease.')

    const existing = await this.#findExistingDescriptor(stateFilePath)
    if (existing) return this.#claimDescriptor(existing, true)

    const releaseLaunchLock = await this.#acquireLaunchLock(stateFilePath, startupTimeoutMs)
    try {
      if (this.releasing) throw new Error('The native shell is releasing its Ensync Host lease.')
      // A different native shell may have started the daemon while this one
      // waited on the cross-process launch fence.
      const raced = await this.#findExistingDescriptor(stateFilePath)
      if (raced) return this.#claimDescriptor(raced, true)
      if (this.releasing) throw new Error('The native shell is releasing its Ensync Host lease.')
      await rm(stateFilePath, { force: true })

      const token = randomBytes(32).toString('hex')
      const child = spawnImpl(executable, [bootstrapPath], {
        cwd,
        env: {
          ...process.env,
          ...env,
          ELECTRON_RUN_AS_NODE: '1',
          ENSYNC_HOST_ENTRY: hostEntryPath,
          ENSYNC_HOST_AUTH_TOKEN: token,
          ENSYNC_HOST_STATE_FILE: stateFilePath,
          ENSYNC_HOST_JOB_JOURNAL_FILE: journalFilePath,
        },
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      })
      this.child = child
      let spawnError = null
      child.once('error', (error) => { spawnError = error })
      child.unref()

      const deadline = Date.now() + startupTimeoutMs
      while (Date.now() < deadline) {
        if (this.releasing) throw new Error('The native shell is releasing its Ensync Host lease.')
        if (spawnError) throw spawnError
        const descriptor = await this.#readHealthyDescriptor(stateFilePath)
        if (descriptor) return this.#claimDescriptor(descriptor, false)
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
      this.child = null
      throw new Error('Detached Ensync Host did not become ready before the startup timeout.')
    } finally {
      await releaseLaunchLock()
    }
  }

  async #readDescriptor(path) {
    try {
      const descriptor = JSON.parse(await readFile(path, 'utf8'))
      if (descriptor?.version !== 1
        || descriptor.apiVersion !== 1
        || !Number.isInteger(descriptor.pid)
        || descriptor.pid < 1
        || !Number.isInteger(descriptor.port)
        || descriptor.port < 1
        || descriptor.port > 65_535
        || typeof descriptor.token !== 'string'
        || !/^[a-f0-9]{64}$/.test(descriptor.token)
        || typeof descriptor.instanceId !== 'string') return null
      return descriptor
    } catch {
      return null
    }
  }

  async #readHealthyDescriptor(stateFilePath) {
    const candidates = await Promise.all([
      this.#readDescriptor(stateFilePath),
      this.#readDescriptor(`${stateFilePath}.backup`),
    ])
    for (const descriptor of candidates.filter(Boolean)) {
      try {
        const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/health`, {
          headers: { Authorization: `Bearer ${descriptor.token}` },
          signal: AbortSignal.timeout(2_000),
        })
        if (!response.ok) continue
        const health = await response.json()
        if (health?.ok === true
          && health?.service === 'ensync-host'
          && health?.apiVersion === 1
          && health?.instanceId === descriptor.instanceId) return descriptor
      } catch {
        // A busy Host may miss one health deadline; its live PID remains a
        // fence against launching another journal writer.
      }
    }
    return null
  }

  async #findExistingDescriptor(stateFilePath) {
    const initial = await Promise.all([
      this.#readDescriptor(stateFilePath),
      this.#readDescriptor(`${stateFilePath}.backup`),
    ])
    const live = initial.filter((descriptor) => descriptor && processIsAlive(descriptor.pid))
    if (live.length === 0) return null

    const deadline = Date.now() + (this.options.descriptorRetryMs ?? DEFAULT_DESCRIPTOR_RETRY_MS)
    do {
      const healthy = await this.#readHealthyDescriptor(stateFilePath)
      if (healthy) return healthy
      if (!live.some((descriptor) => processIsAlive(descriptor.pid))) return null
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    } while (Date.now() < deadline)

    throw new Error('A live detached Ensync Host owns this project but did not answer its health check. Ensync preserved that Host and did not start a competing process.')
  }

  async #acquireLaunchLock(stateFilePath, timeoutMs) {
    const lockPath = `${stateFilePath}.launch-lock`
    const ownerPath = `${lockPath}/owner.json`
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await mkdir(lockPath, { mode: 0o700 })
        await writeFile(ownerPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), {
          encoding: 'utf8',
          mode: 0o600,
        })
        return async () => rm(lockPath, { recursive: true, force: true })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }

      let ownerPid = null
      let createdAt = NaN
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
        ownerPid = owner?.pid
        createdAt = Date.parse(owner?.createdAt ?? '')
      } catch {
        try { createdAt = (await stat(lockPath)).mtimeMs } catch { continue }
      }
      if (!processIsAlive(ownerPid) && Number.isFinite(createdAt) && Date.now() - createdAt > LAUNCH_LOCK_STALE_MS) {
        const quarantine = `${lockPath}.stale-${randomUUID()}`
        try {
          await rename(lockPath, quarantine)
          await rm(quarantine, { recursive: true, force: true })
          continue
        } catch (error) {
          if (error?.code !== 'ENOENT') await new Promise((resolveWait) => setTimeout(resolveWait, 100))
        }
      } else {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
    }
    throw new Error('Timed out waiting for another Ensync shell to finish starting the detached Host.')
  }

  async #claimDescriptor(descriptor, reused) {
    if (this.releasing) throw new Error('The native shell is releasing its Ensync Host lease.')
    const payload = await this.#daemonRequest(descriptor.port, descriptor.token, '/api/daemon/claim', {
      ownerId: this.ownerId,
    })
    if (this.releasing) {
      await this.#daemonRequest(descriptor.port, descriptor.token, '/api/daemon/release', {
        ownerId: this.ownerId,
      }).catch(() => {})
      throw new Error('The native shell released its Ensync Host lease.')
    }
    this.port = descriptor.port
    this.authToken = descriptor.token
    const expiresAtMs = Date.parse(payload?.lease?.expiresAt ?? '')
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      this.port = null
      this.authToken = null
      throw new Error('Detached Ensync Host returned an invalid shell lease.')
    }
    this.leaseExpiresAtMs = expiresAtMs
    this.heartbeatTimer = setInterval(() => {
      if (!this.releasing) void this.ensureConnected({ force: true }).catch(() => {})
    }, this.options.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS)
    this.heartbeatTimer.unref?.()
    return { port: descriptor.port, child: this.child, reused }
  }

  async #daemonRequest(port, token, path, body) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) throw new Error(`Detached Ensync Host lease failed (${response.status}).`)
    return response.json()
  }
}

async function resolveStaticFile(uiRoot, requestPath) {
  let decoded
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = resolve(uiRoot, requested)
  const relation = relative(uiRoot, candidate)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return null

  try {
    if ((await stat(candidate)).isFile()) return candidate
  } catch {
    // A route without a built asset falls back to the SPA entry point.
  }
  return resolve(uiRoot, 'index.html')
}

function plainResponse(status, text, security) {
  return new Response(text, {
    status,
    headers: {
      ...security,
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

function proxyHeaders(requestHeaders, hostToken, ownerId) {
  const headers = new Headers(requestHeaders)
  for (const name of [
    'connection',
    'content-length',
    'host',
    'authorization',
    'origin',
    'referer',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'x-ensync-owner',
  ]) {
    headers.delete(name)
  }
  if (hostToken) headers.set('Authorization', `Bearer ${hostToken}`)
  if (ownerId) headers.set('X-Ensync-Owner', ownerId)
  return headers
}

async function proxyProtocolApi(
  request,
  url,
  hostPort,
  security,
  fetchImpl,
  hostToken,
  ownerId,
  ensureHostLease,
  resolveHostConnection,
) {
  if (!['GET', 'POST', 'OPTIONS'].includes(request.method)) {
    return plainResponse(405, 'Method not allowed.', security)
  }

  let connection = { hostPort, hostToken, ownerId }
  try {
    if (resolveHostConnection) connection = await resolveHostConnection()
    else await ensureHostLease?.()
    if (!Number.isInteger(connection?.port ?? connection?.hostPort)
      || (connection.port ?? connection.hostPort) < 1
      || (connection.port ?? connection.hostPort) > 65_535) {
      throw new Error('Ensync Host returned an invalid endpoint.')
    }
  } catch {
    return new Response(JSON.stringify({
      error: 'Ensync Host could not reconnect safely.',
      code: 'host_connection_recovery_failed',
      safeToRetry: true,
    }), {
      status: 503,
      headers: {
        ...security,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
    })
  }

  const resolvedPort = connection.port ?? connection.hostPort
  const resolvedToken = connection.authToken ?? connection.hostToken
  const resolvedOwnerId = connection.ownerId
  const upstreamUrl = `http://127.0.0.1:${resolvedPort}${url.pathname}${url.search}`
  const body = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : Buffer.from(await request.arrayBuffer())

  try {
    const upstream = await fetchImpl(upstreamUrl, {
      method: request.method,
      headers: proxyHeaders(request.headers, resolvedToken, resolvedOwnerId),
      body,
      redirect: 'error',
      signal: request.signal,
    })
    const headers = new Headers(upstream.headers)
    for (const [name, value] of Object.entries(security)) headers.set(name, value)
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  } catch (error) {
    if (request.signal.aborted) throw error
    return plainResponse(502, 'Ensync Host is unavailable.', security)
  }
}

async function serveProtocolStatic(request, url, uiRoot, security) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return plainResponse(405, 'Method not allowed.', security)
  }

  const filePath = await resolveStaticFile(uiRoot, url.pathname)
  if (!filePath) return plainResponse(400, 'Invalid path.', security)

  try {
    const [fileStat, body] = await Promise.all([
      stat(filePath),
      request.method === 'HEAD' ? Promise.resolve(null) : readFile(filePath),
    ])
    return new Response(body, {
      status: 200,
      headers: {
        ...security,
        'Cache-Control': extname(filePath) === '.html'
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
        'Content-Length': String(fileStat.size),
        'Content-Type': MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
      },
    })
  } catch {
    return plainResponse(404, 'UI asset not found.', security)
  }
}

export async function createAppProtocolHandler(options) {
  const uiRoot = resolve(options.uiRoot)
  const indexPath = resolve(uiRoot, 'index.html')
  await access(indexPath)
  const indexHtml = await readFile(indexPath, 'utf8')
  const inlineScriptHashes = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => createHash('sha256').update(match[1]).digest('base64'))
  const security = securityHeaders(inlineScriptHashes)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  return async (request) => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return plainResponse(400, 'Invalid URL.', security)
    }
    if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST) {
      return plainResponse(404, 'Not found.', security)
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return proxyProtocolApi(
        request,
        url,
        options.hostPort,
        security,
        fetchImpl,
        options.hostToken,
        options.ownerId,
        options.ensureHostLease,
        options.resolveHostConnection,
      )
    }
    return serveProtocolStatic(request, url, uiRoot, security)
  }
}

export async function verifyUiBundle(uiRoot) {
  const html = await readFile(resolve(uiRoot, 'index.html'), 'utf8')
  if (!html.includes('<div id="root"></div>')) {
    throw new Error('The bundled UI index is not an Ensync Vite build.')
  }
  return true
}

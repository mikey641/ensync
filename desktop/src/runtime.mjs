import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, readFile, rm, stat } from 'node:fs/promises'
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
    this.ownerId = options.ownerId ?? `shell_${randomUUID()}`
  }

  async start() {
    if (this.child) throw new Error('Ensync Host is already running.')
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

    const child = spawnImpl(executable, [bootstrapPath], {
      cwd,
      env: {
        ...process.env,
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        ENSYNC_HOST_ENTRY: hostEntryPath,
      },
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    const port = this.port
    const authToken = this.authToken
    this.child = null
    this.port = null
    this.authToken = null
    if (!port || !authToken) return
    await this.#daemonRequest(port, authToken, '/api/daemon/release', {
      ownerId: this.ownerId,
    }).catch(() => {})
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
    await Promise.all([access(bootstrapPath), access(hostEntryPath)])

    const existing = await this.#readHealthyDescriptor(stateFilePath)
    if (existing) return this.#claimDescriptor(existing, true)
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
      if (spawnError) throw spawnError
      const descriptor = await this.#readHealthyDescriptor(stateFilePath)
      if (descriptor) return this.#claimDescriptor(descriptor, false)
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    this.child = null
    throw new Error('Detached Ensync Host did not become ready before the startup timeout.')
  }

  async #readHealthyDescriptor(stateFilePath) {
    try {
      const descriptor = JSON.parse(await readFile(stateFilePath, 'utf8'))
      if (descriptor?.version !== 1
        || descriptor.apiVersion !== 1
        || !Number.isInteger(descriptor.port)
        || descriptor.port < 1
        || descriptor.port > 65_535
        || typeof descriptor.token !== 'string'
        || !/^[a-f0-9]{64}$/.test(descriptor.token)
        || typeof descriptor.instanceId !== 'string') return null
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/health`, {
        headers: { Authorization: `Bearer ${descriptor.token}` },
        signal: AbortSignal.timeout(1_000),
      })
      if (!response.ok) return null
      const health = await response.json()
      return health?.ok === true
        && health?.service === 'ensync-host'
        && health?.apiVersion === 1
        && health?.instanceId === descriptor.instanceId
        ? descriptor
        : null
    } catch {
      return null
    }
  }

  async #claimDescriptor(descriptor, reused) {
    await this.#daemonRequest(descriptor.port, descriptor.token, '/api/daemon/claim', {
      ownerId: this.ownerId,
    })
    this.port = descriptor.port
    this.authToken = descriptor.token
    this.heartbeatTimer = setInterval(() => {
      void this.#daemonRequest(descriptor.port, descriptor.token, '/api/daemon/heartbeat', {
        ownerId: this.ownerId,
      }).catch(() => {})
    }, 15_000)
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

async function proxyProtocolApi(request, url, hostPort, security, fetchImpl, hostToken, ownerId) {
  if (!['GET', 'POST', 'OPTIONS'].includes(request.method)) {
    return plainResponse(405, 'Method not allowed.', security)
  }

  const upstreamUrl = `http://127.0.0.1:${hostPort}${url.pathname}${url.search}`
  const body = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : Buffer.from(await request.arrayBuffer())

  try {
    const upstream = await fetchImpl(upstreamUrl, {
      method: request.method,
      headers: proxyHeaders(request.headers, hostToken, ownerId),
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

import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APP_ORIGIN,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
  HostProcessController,
} from '../src/runtime.mjs'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(desktopRoot, '..')

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return server.address().port
}

async function close(server) {
  await new Promise((resolveClose) => server.close(resolveClose))
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for detached Host state.')
}

function processIsAliveForTest(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

test('desktop bootstrap starts the real Ensync Host on an ephemeral port and stops it', async () => {
  const controller = new HostProcessController({
    bootstrapPath: resolve(desktopRoot, 'src', 'host-bootstrap.mjs'),
    hostEntryPath: resolve(repositoryRoot, 'host', 'server.mjs'),
    cwd: repositoryRoot,
    executable: process.execPath,
    env: {
      ENSYNC_DEFAULT_PROJECT_PATH: repositoryRoot,
      ENSYNC_HOST_AUTH_TOKEN: 'ambient detached credential must be ignored',
    },
  })

  try {
    const { port } = await controller.start()
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).ok, true)
  } finally {
    await controller.stop()
  }
})

test('native shells reuse one authenticated detached Host and release it without killing another owner', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-host-daemon-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'daemon.json')
  const journalFilePath = join(directory, 'jobs.json')
  const baseOptions = {
    bootstrapPath: resolve(desktopRoot, 'src', 'host-bootstrap.mjs'),
    hostEntryPath: resolve(repositoryRoot, 'host', 'server.mjs'),
    cwd: repositoryRoot,
    executable: process.execPath,
    stateFilePath,
    journalFilePath,
    env: {
      ENSYNC_DEFAULT_PROJECT_PATH: repositoryRoot,
      ENSYNC_HOST_IDLE_SHUTDOWN_MS: '250',
    },
  }
  const first = new HostProcessController({ ...baseOptions, ownerId: 'shell_1111111111111111' })
  const second = new HostProcessController({ ...baseOptions, ownerId: 'shell_2222222222222222' })
  try {
    const [firstResult, secondResult] = await Promise.all([first.start(), second.start()])
    assert.deepEqual([firstResult.reused, secondResult.reused].sort(), [false, true])
    assert.equal(secondResult.port, firstResult.port)
    const launched = firstResult

    const unauthorized = await fetch(`http://127.0.0.1:${launched.port}/api/health`)
    assert.equal(unauthorized.status, 401)
    await first.release()
    const stillAlive = await fetch(`http://127.0.0.1:${launched.port}/api/health`, {
      headers: { Authorization: `Bearer ${second.authToken}` },
    })
    assert.equal(stillAlive.status, 200)

    const releasedLease = await fetch(`http://127.0.0.1:${launched.port}/api/daemon/release`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${second.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ownerId: second.ownerId }),
    })
    assert.equal(releasedLease.status, 200)
    const rejectedWithoutLease = await fetch(`http://127.0.0.1:${launched.port}/api/projects/current`, {
      headers: {
        Authorization: `Bearer ${second.authToken}`,
        'X-Ensync-Owner': second.ownerId,
      },
    })
    assert.equal(rejectedWithoutLease.status, 403)

    await second.ensureLease({ force: true })
    const recoveredLease = await fetch(`http://127.0.0.1:${launched.port}/api/projects/current`, {
      headers: {
        Authorization: `Bearer ${second.authToken}`,
        'X-Ensync-Owner': second.ownerId,
      },
    })
    assert.equal(recoveredLease.status, 200)
  } finally {
    await first.release()
    await second.release()
  }
  await waitFor(async () => {
    try { await access(stateFilePath); return false } catch { return true }
  })
})

test('a transient health timeout on a live detached Host never spawns a competing Host', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-host-health-retry-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'daemon.json')
  const journalFilePath = join(directory, 'jobs.json')
  const token = 'a'.repeat(64)
  const instanceId = 'existing-live-host'
  let healthRequests = 0
  let spawned = false
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    if (request.url === '/api/health') {
      healthRequests += 1
      const reply = () => {
        if (response.destroyed) return
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ok: true, service: 'ensync-host', apiVersion: 1, instanceId }))
      }
      if (healthRequests === 1) setTimeout(reply, 2_100)
      else reply()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }))
  })
  const port = await listen(server)
  context.after(() => close(server))
  await writeFile(stateFilePath, JSON.stringify({
    version: 1, apiVersion: 1, pid: process.pid, port, token, instanceId,
  }))

  const controller = new HostProcessController({
    bootstrapPath: resolve(desktopRoot, 'src', 'host-bootstrap.mjs'),
    hostEntryPath: resolve(repositoryRoot, 'host', 'server.mjs'),
    cwd: repositoryRoot,
    stateFilePath,
    journalFilePath,
    descriptorRetryMs: 5_000,
    spawnImpl: () => {
      spawned = true
      throw new Error('must not spawn')
    },
  })
  try {
    const result = await controller.start()
    assert.equal(result.reused, true)
    assert.equal(result.port, port)
    assert.equal(spawned, false)
    assert.ok(healthRequests >= 2)
  } finally {
    await controller.release()
  }
})

test('shell release never waits for an in-flight detached Host health recovery', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-host-release-recovery-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'daemon.json')
  const journalFilePath = join(directory, 'jobs.json')
  const token = 'b'.repeat(64)
  const instanceId = 'release-recovery-host'
  let unavailable = false
  let stalledHealthRequests = 0
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    if (request.url === '/api/health') {
      if (unavailable) {
        stalledHealthRequests += 1
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, service: 'ensync-host', apiVersion: 1, instanceId }))
      return
    }
    if (unavailable && request.url !== '/api/daemon/release') {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'temporarily unavailable' }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }))
  })
  const port = await listen(server)
  context.after(() => close(server))
  await writeFile(stateFilePath, JSON.stringify({
    version: 1, apiVersion: 1, pid: process.pid, port, token, instanceId,
  }))

  const controller = new HostProcessController({
    bootstrapPath: resolve(desktopRoot, 'src', 'host-bootstrap.mjs'),
    hostEntryPath: resolve(repositoryRoot, 'host', 'server.mjs'),
    cwd: repositoryRoot,
    stateFilePath,
    journalFilePath,
    descriptorRetryMs: 100,
    spawnImpl: () => { throw new Error('must not spawn') },
  })
  await controller.start()
  unavailable = true
  const reconnect = controller.ensureConnected({ force: true })
  await waitFor(() => stalledHealthRequests > 0)

  const releaseStartedAt = Date.now()
  await controller.release()
  const releaseElapsedMs = Date.now() - releaseStartedAt
  assert.ok(releaseElapsedMs < 750, `release took ${releaseElapsedMs}ms`)
  await assert.rejects(reconnect)
})

test('a native shell replaces a dead detached Host in place before the next renderer request', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-host-reconnect-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'daemon.json')
  const journalFilePath = join(directory, 'jobs.json')
  const controller = new HostProcessController({
    bootstrapPath: resolve(desktopRoot, 'src', 'host-bootstrap.mjs'),
    hostEntryPath: resolve(repositoryRoot, 'host', 'server.mjs'),
    cwd: repositoryRoot,
    executable: process.execPath,
    stateFilePath,
    journalFilePath,
    env: {
      ENSYNC_DEFAULT_PROJECT_PATH: repositoryRoot,
      ENSYNC_HOST_IDLE_SHUTDOWN_MS: '250',
    },
  })

  try {
    await controller.start()
    const firstDescriptor = JSON.parse(await readFile(stateFilePath, 'utf8'))
    process.kill(firstDescriptor.pid)
    await waitFor(() => !processIsAliveForTest(firstDescriptor.pid))

    const replacement = await controller.ensureConnected({ force: true })
    const replacementDescriptor = JSON.parse(await readFile(stateFilePath, 'utf8'))
    assert.notEqual(replacementDescriptor.instanceId, firstDescriptor.instanceId)
    assert.equal(replacement.port, replacementDescriptor.port)
    const response = await fetch(`http://127.0.0.1:${replacement.port}/api/health`, {
      headers: { Authorization: `Bearer ${replacement.authToken}` },
    })
    assert.equal(response.status, 200)
  } finally {
    await controller.release()
  }
})

test('app protocol serves the bundle with security headers and proxies only the host API', async () => {
  const uiRoot = await mkdtemp(join(tmpdir(), 'ensync-ui-'))
  await writeFile(join(uiRoot, 'index.html'), '<!doctype html><div id="root"></div>')
  const host = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ path: request.url, method: request.method }))
  })
  const hostPort = await listen(host)
  const handle = await createAppProtocolHandler({ uiRoot, hostPort })

  try {
    const page = await handle(new Request(`${APP_ORIGIN}/`))
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
    assert.match(await page.text(), /id="root"/)

    const api = await handle(new Request(`${APP_ORIGIN}/api/health`))
    assert.deepEqual(await api.json(), { path: '/api/health', method: 'GET' })

    const route = await handle(new Request(`${APP_ORIGIN}/projects/example`))
    assert.match(await route.text(), /id="root"/)

    const foreignHost = await handle(new Request('ensync://untrusted/'))
    assert.equal(foreignHost.status, 404)
  } finally {
    await close(host)
    await rm(uiRoot, { recursive: true, force: true })
  }
})

test('app protocol keeps one secure standard storage origin across host restarts', async () => {
  assert.equal(APP_ORIGIN, 'ensync://app')
  assert.deepEqual(APP_SCHEME_PRIVILEGES, {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  })
  assert.equal('bypassCSP' in APP_SCHEME_PRIVILEGES, false)

  const uiRoot = await mkdtemp(join(tmpdir(), 'ensync-ui-origin-'))
  await writeFile(join(uiRoot, 'index.html'), '<!doctype html><div id="root"></div>')
  const upstreamUrls = []
  const fetchImpl = async (url) => {
    upstreamUrls.push(url)
    return Response.json({ ok: true })
  }

  try {
    for (const hostPort of [41_001, 52_002]) {
      const handle = await createAppProtocolHandler({ uiRoot, hostPort, fetchImpl })
      const response = await handle(new Request(`${APP_ORIGIN}/api/health`))
      assert.equal(response.status, 200)
    }
    assert.deepEqual(upstreamUrls, [
      'http://127.0.0.1:41001/api/health',
      'http://127.0.0.1:52002/api/health',
    ])
  } finally {
    await rm(uiRoot, { recursive: true, force: true })
  }
})

test('app protocol strips renderer origins before its private loopback API hop', async () => {
  const uiRoot = await mkdtemp(join(tmpdir(), 'ensync-ui-headers-'))
  await writeFile(join(uiRoot, 'index.html'), '<!doctype html><div id="root"></div>')
  let forwardedHeaders
  let forwardedBody
  let forwardedSignal
  let leaseChecks = 0
  const fetchImpl = async (_url, init) => {
    forwardedHeaders = init.headers
    forwardedBody = init.body
    forwardedSignal = init.signal
    return Response.json({ ok: true })
  }
  const handle = await createAppProtocolHandler({
    uiRoot,
    hostPort: 43_121,
    hostToken: 'host-secret-token',
    ownerId: 'shell_1111111111111111',
    ensureHostLease: async () => { leaseChecks += 1 },
    fetchImpl,
  })

  try {
    const request = new Request(`${APP_ORIGIN}/api/projects/inspect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: APP_ORIGIN,
        Referer: `${APP_ORIGIN}/`,
        Authorization: 'Bearer renderer-controlled-value',
      },
      body: JSON.stringify({ path: '/tmp/project' }),
    })
    const response = await handle(request)
    assert.equal(response.status, 200)
    assert.equal(forwardedHeaders.has('origin'), false)
    assert.equal(forwardedHeaders.has('referer'), false)
    assert.equal(forwardedHeaders.get('authorization'), 'Bearer host-secret-token')
    assert.equal(forwardedHeaders.get('x-ensync-owner'), 'shell_1111111111111111')
    assert.equal(forwardedBody.toString(), JSON.stringify({ path: '/tmp/project' }))
    assert.equal(forwardedSignal, request.signal)
    assert.equal(leaseChecks, 1)
  } finally {
    await rm(uiRoot, { recursive: true, force: true })
  }
})

test('app protocol does not proxy renderer work when its shell lease cannot be repaired', async () => {
  const uiRoot = await mkdtemp(join(tmpdir(), 'ensync-ui-lease-failure-'))
  await writeFile(join(uiRoot, 'index.html'), '<!doctype html><div id="root"></div>')
  let upstreamRequests = 0
  const handle = await createAppProtocolHandler({
    uiRoot,
    hostPort: 43_121,
    ensureHostLease: async () => { throw new Error('lease unavailable') },
    fetchImpl: async () => {
      upstreamRequests += 1
      return Response.json({ ok: true })
    },
  })

  try {
    const response = await handle(new Request(`${APP_ORIGIN}/api/projects/current`))
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'Ensync Host could not reconnect safely.',
      code: 'host_connection_recovery_failed',
      safeToRetry: true,
    })
    assert.equal(upstreamRequests, 0)
  } finally {
    await rm(uiRoot, { recursive: true, force: true })
  }
})

test('app protocol resolves a replacement Host endpoint without changing the renderer origin', async () => {
  const uiRoot = await mkdtemp(join(tmpdir(), 'ensync-ui-live-host-recovery-'))
  await writeFile(join(uiRoot, 'index.html'), '<!doctype html><div id="root"></div>')
  const upstreamUrls = []
  let port = 41_001
  const handle = await createAppProtocolHandler({
    uiRoot,
    resolveHostConnection: async () => ({
      port,
      authToken: 'replacement-secret',
      ownerId: 'shell_1111111111111111',
    }),
    fetchImpl: async (url) => {
      upstreamUrls.push(url)
      return Response.json({ ok: true })
    },
  })

  try {
    assert.equal((await handle(new Request(`${APP_ORIGIN}/api/health`))).status, 200)
    port = 52_002
    assert.equal((await handle(new Request(`${APP_ORIGIN}/api/providers`))).status, 200)
    assert.deepEqual(upstreamUrls, [
      'http://127.0.0.1:41001/api/health',
      'http://127.0.0.1:52002/api/providers',
    ])
  } finally {
    await rm(uiRoot, { recursive: true, force: true })
  }
})

test('app protocol forwards NDJSON response bodies without buffering the execution stream', async () => {
  const uiRoot = await mkdtemp(join(tmpdir(), 'ensync-ui-stream-'))
  await writeFile(join(uiRoot, 'index.html'), '<!doctype html><div id="root"></div>')
  let releaseSecondChunk
  const secondChunk = new Promise((resolve) => { releaseSecondChunk = resolve })
  const encoder = new TextEncoder()
  const fetchImpl = async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode('{"type":"started"}\n'))
      await secondChunk
      controller.enqueue(encoder.encode('{"type":"completed"}\n'))
      controller.close()
    },
  }), {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  })
  const handle = await createAppProtocolHandler({ uiRoot, hostPort: 43_121, fetchImpl })

  try {
    const response = await handle(new Request(`${APP_ORIGIN}/api/chat/run/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'codex' }),
    }))
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    assert.equal(decoder.decode((await reader.read()).value), '{"type":"started"}\n')
    releaseSecondChunk()
    assert.equal(decoder.decode((await reader.read()).value), '{"type":"completed"}\n')
    assert.equal((await reader.read()).done, true)
  } finally {
    releaseSecondChunk()
    await rm(uiRoot, { recursive: true, force: true })
  }
})

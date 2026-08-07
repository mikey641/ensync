import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test('desktop bootstrap starts the real Ensync Host on an ephemeral port and stops it', async () => {
  const controller = new HostProcessController({
    bootstrapPath: resolve(desktopRoot, 'src', 'host-bootstrap.mjs'),
    hostEntryPath: resolve(repositoryRoot, 'host', 'server.mjs'),
    cwd: repositoryRoot,
    executable: process.execPath,
    env: { ENSYNC_DEFAULT_PROJECT_PATH: repositoryRoot },
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
    const launched = await first.start()
    const reused = await second.start()
    assert.equal(launched.reused, false)
    assert.equal(reused.reused, true)
    assert.equal(reused.port, launched.port)

    const unauthorized = await fetch(`http://127.0.0.1:${launched.port}/api/health`)
    assert.equal(unauthorized.status, 401)
    await first.release()
    const stillAlive = await fetch(`http://127.0.0.1:${launched.port}/api/health`, {
      headers: { Authorization: `Bearer ${second.authToken}` },
    })
    assert.equal(stillAlive.status, 200)
  } finally {
    await first.release()
    await second.release()
  }
  await waitFor(async () => {
    try { await access(stateFilePath); return false } catch { return true }
  })
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

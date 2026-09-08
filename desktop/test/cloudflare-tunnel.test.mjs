import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cloudflaredAsset,
  cloudflaredBinaryName,
  cloudflaredDownloadUrl,
  cloudflaredQuickRunArgs,
  cloudflaredRunArgs,
  CloudflareTunnelError,
  normalizeTunnelState,
  parseQuickTunnelUrl,
  processIsAlive,
  provisionTunnel,
  publicTunnelUrl,
  resolveLocalCloudflaredPath,
  resolveZone,
  resolveZoneId,
  startCloudflared,
  stopCloudflared,
} from '../src/cloudflare-tunnel.mjs'

function apiResponse(result, options = {}) {
  const status = options.status ?? 200
  return {
    status,
    ok: options.ok ?? status < 400,
    json: async () => ({ success: options.success ?? true, result, errors: options.errors ?? [] }),
  }
}

test('cloudflared binaries resolve per platform and architecture', () => {
  assert.deepEqual(cloudflaredAsset({ platform: 'darwin', arch: 'arm64' }).archive, 'cloudflared-darwin-arm64.tgz')
  assert.deepEqual(cloudflaredAsset({ platform: 'darwin', arch: 'x64' }).archive, 'cloudflared-darwin-amd64.tgz')
  assert.equal(cloudflaredAsset({ platform: 'win32', arch: 'x64' }).binaryName, 'cloudflared-amd64.exe')
  assert.equal(cloudflaredAsset({ platform: 'linux', arch: 'arm64' }).archive, 'cloudflared-linux-arm64')
  assert.throws(() => cloudflaredAsset({ platform: 'freebsd', arch: 'x64' }), CloudflareTunnelError)
})

test('the download URL points at a latest-release cloudflared artifact', () => {
  assert.match(
    cloudflaredDownloadUrl(cloudflaredAsset({ platform: 'darwin', arch: 'arm64' })),
    /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/latest\/download\/cloudflared-darwin-arm64\.tgz$/,
  )
  assert.equal(cloudflaredBinaryName('win32'), 'cloudflared.exe')
  assert.equal(cloudflaredBinaryName('darwin'), 'cloudflared')
})

test('a local cloudflared path prefers the operator override then the app bin dir', () => {
  assert.equal(
    resolveLocalCloudflaredPath({ env: { ENSYNC_CLOUDFLARED_PATH: '/opt/cfd' }, appBinsDir: '/bins' }),
    '/opt/cfd',
  )
  assert.equal(
    resolveLocalCloudflaredPath({ platform: 'darwin', env: {}, appBinsDir: '/bins' }),
    '/bins/cloudflared',
  )
  assert.equal(resolveLocalCloudflaredPath({ env: {}, appBinsDir: null }), null)
})

test('provisioning writes the correct ingress and DNS shapes', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    const method = init.method ?? 'GET'
    const path = new URL(url).pathname
    if (method === 'GET' && path.endsWith('/zones')) return apiResponse([{ id: 'zone-1', name: 'example.com' }])
    if (method === 'POST' && path.endsWith('/tunnels')) return apiResponse({ id: 'tunnel-9' })
    if (method === 'GET' && path.endsWith('/token')) return apiResponse('run.secret.token')
    if (method === 'PUT' && path.endsWith('/configurations')) return apiResponse({})
    if (method === 'POST' && path.endsWith('/dns_records')) return apiResponse({ id: 'dns-1' })
    return apiResponse(null, { status: 404, success: false, errors: [{ code: 7000, message: 'not found' }] })
  }

  const result = await provisionTunnel({
    token: 'api-token',
    accountId: 'acct-1',
    domain: 'example.com',
    hostname: 'sync.example.com',
    serviceUrl: 'http://127.0.0.1:43122',
    fetchImpl,
  })

  assert.deepEqual(result, {
    tunnelId: 'tunnel-9',
    hostname: 'sync.example.com',
    runToken: 'run.secret.token',
    accountId: 'acct-1',
  })

  const ingress = JSON.parse(calls.find((call) => call.init.method === 'PUT').init.body)
  assert.deepEqual(ingress.config.ingress, [
    { hostname: 'sync.example.com', service: 'http://127.0.0.1:43122' },
    { service: 'http_status:404' },
  ])

  const dns = JSON.parse(calls.find((call) => call.init.method === 'POST' && call.url.endsWith('/dns_records')).init.body)
  assert.deepEqual(dns, {
    type: 'CNAME',
    name: 'sync.example.com',
    content: 'tunnel-9.cfargotunnel.com',
    proxied: true,
    ttl: 1,
  })
})

test('provisioning surfaces Cloudflare API errors without leaking the token', async () => {
  const fetchImpl = async () => apiResponse(null, {
    status: 403,
    success: false,
    errors: [{ code: 9109, message: 'unauthorized' }],
  })

  await assert.rejects(
    () => provisionTunnel({ token: 'api-token', accountId: 'acct-1', domain: 'example.com', hostname: 'sync.example.com', fetchImpl }),
    (error) => error instanceof CloudflareTunnelError
      && error.code === '9109'
      && error.status === 403
      && !error.message.includes('api-token'),
  )
})

test('resolveZoneId requires an existing zone and rejects a missing domain', async () => {
  await assert.rejects(
    () => resolveZoneId('token', '   ', { fetchImpl: async () => apiResponse([]) }),
    (error) => error instanceof CloudflareTunnelError && error.code === 'cloudflare_domain_required',
  )
  await assert.rejects(
    () => resolveZoneId('token', 'missing.example.com', { fetchImpl: async () => apiResponse([]) }),
    (error) => error instanceof CloudflareTunnelError && error.code === 'cloudflare_zone_not_found',
  )
})

test('resolveZone returns the owner account so setup needs no account id input', async () => {
  const fetchImpl = async () => apiResponse([{ id: 'zone-1', name: 'example.com', account: { id: 'acct-1' } }])
  assert.deepEqual(await resolveZone('token', 'example.com', { fetchImpl }), { id: 'zone-1', accountId: 'acct-1' })
  assert.equal(await resolveZoneId('token', 'example.com', { fetchImpl }), 'zone-1')
})

test('provisioning resolves the account id from the zone when none is supplied', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    const method = init.method ?? 'GET'
    const path = new URL(url).pathname
    if (method === 'GET' && path.endsWith('/zones')) {
      return apiResponse([{ id: 'zone-1', name: 'example.com', account: { id: 'acct-zone' } }])
    }
    if (method === 'POST' && path.includes('/accounts/acct-zone/tunnels')) return apiResponse({ id: 'tunnel-9' })
    if (method === 'GET' && path.endsWith('/token')) return apiResponse('run.secret.token')
    if (method === 'PUT' && path.endsWith('/configurations')) return apiResponse({})
    if (method === 'POST' && path.endsWith('/dns_records')) return apiResponse({ id: 'dns-1' })
    return apiResponse(null, { status: 404, success: false, errors: [{ code: 7000, message: 'not found' }] })
  }

  const result = await provisionTunnel({
    token: 'api-token',
    domain: 'example.com',
    hostname: 'sync.example.com',
    fetchImpl,
  })

  assert.equal(result.accountId, 'acct-zone')
  assert.equal(result.hostname, 'sync.example.com')
})

test('cloudflared run arguments pin the token and disable autoupdate', () => {
  assert.deepEqual(cloudflaredRunArgs({ token: 'tok' }), ['tunnel', '--no-autoupdate', 'run', '--token', 'tok'])
  assert.deepEqual(cloudflaredRunArgs({ token: 'tok', noAutoupdate: false }), ['tunnel', 'run', '--token', 'tok'])
  assert.throws(() => cloudflaredRunArgs({}), CloudflareTunnelError)
})

test('quick run arguments point cloudflared at the local loopback service', () => {
  assert.deepEqual(cloudflaredQuickRunArgs(), ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:43122'])
  assert.deepEqual(
    cloudflaredQuickRunArgs({ serviceUrl: 'http://127.0.0.1:5999', noAutoupdate: false }),
    ['tunnel', '--url', 'http://127.0.0.1:5999'],
  )
  assert.throws(() => cloudflaredQuickRunArgs({ serviceUrl: ' ' }), CloudflareTunnelError)
})

test('quick tunnel URLs are parsed from cloudflared log output', () => {
  assert.equal(
    parseQuickTunnelUrl('2026-09-07T00:00:00Z INF Your quick Tunnel has been created: https://quiet-fox-1a2b.trycloudflare.com'),
    'https://quiet-fox-1a2b.trycloudflare.com',
  )
  assert.equal(parseQuickTunnelUrl('no url here'), null)
  assert.equal(parseQuickTunnelUrl(null), null)
})

test('a detached cloudflared child unrefs and can be stopped', async () => {
  const args = []
  const child = {
    exitCode: null,
    signalCode: null,
    killed: false,
    unrefCalled: false,
    unref() { this.unrefCalled = true },
    kill() { this.killed = true },
  }
  const spawned = startCloudflared({
    binaryPath: '/bins/cloudflared',
    token: 'run-token',
    spawnImpl: (...spawnArgs) => {
      args.push(spawnArgs)
      return child
    },
  })
  assert.equal(spawned, child)
  assert.equal(child.unrefCalled, true)
  assert.deepEqual(args[0][0], '/bins/cloudflared')
  assert.deepEqual(args[0][1], ['tunnel', '--no-autoupdate', 'run', '--token', 'run-token'])

  stopCloudflared(child)
  assert.equal(child.killed, true)
  child.exitCode = 0
  child.killed = false
  stopCloudflared(child)
  assert.equal(child.killed, false)
})

test('process liveness refuses unknown PIDs and accepts injectable kills', () => {
  assert.equal(processIsAlive(123456789), false)
  assert.equal(processIsAlive(process.pid), true)
  assert.equal(processIsAlive(-1), false)
  assert.equal(processIsAlive(4242, () => false), false)
  assert.equal(processIsAlive(4242, () => true), true)
})

test('public tunnel URLs and persisted state are normalized defensively', () => {
  assert.equal(publicTunnelUrl(' sync.example.com '), 'https://sync.example.com')
  assert.equal(publicTunnelUrl(''), null)
  assert.equal(normalizeTunnelState(null), null)
  assert.equal(normalizeTunnelState({ hostname: 'sync.example.com' }), null)
  assert.deepEqual(normalizeTunnelState({ hostname: ' sync.example.com ', tunnelId: 't-1', accountId: 'a-1' }), {
    hostname: 'sync.example.com',
    tunnelId: 't-1',
    accountId: 'a-1',
    savedAt: null,
  })
})

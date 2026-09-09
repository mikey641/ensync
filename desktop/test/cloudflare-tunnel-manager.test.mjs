import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CloudflareTunnelManager } from '../src/cloudflare-tunnel-manager.mjs'
import { createCloudflareTunnelStore } from '../src/cloudflare-tunnel-store.mjs'

function pseudoCipher() {
  const values = new Map()
  let counter = 0
  return {
    encrypt: (value) => {
      const key = `c:${counter}`
      counter += 1
      values.set(key, value)
      return key
    },
    decrypt: (value) => values.get(value) ?? null,
  }
}

function fakeChild(pid = 12345) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    unrefCalled: false,
    unref() { this.unrefCalled = true },
    kill() { this.killed = true },
  }
}

function fakeQuickChild(pid = 6789, output = '') {
  const listeners = { exit: [] }
  return {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    unrefCalled: false,
    stdout: {
      lines: [],
      setEncoding() {},
      on(event, handler) {
        if (event === 'data' && output) handler(Buffer.from(output))
      },
    },
    stderr: {
      setEncoding() {},
      on() {},
    },
    once(event, handler) {
      listeners[event].push(handler)
    },
    emitExit(code = 0) {
      this.exitCode = code
      for (const handler of listeners.exit) handler()
    },
    unref() { this.unrefCalled = true },
    kill() { this.killed = true },
  }
}

test('manager provisions, saves, and starts a tunnel when the binary is present', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-tunnel-manager-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appBinsDir = join(root, 'bins')
  const userDataPath = join(root, 'user-data')
  mkdirSync(appBinsDir, { recursive: true })
  mkdirSync(userDataPath, { recursive: true })
  const binaryPath = join(appBinsDir, 'cloudflared')
  writeFileSync(binaryPath, 'fake binary')
  chmodSync(binaryPath, 0o755)

  const cipher = pseudoCipher()
  const store = createCloudflareTunnelStore({
    filePath: join(userDataPath, 'tunnel.json'),
    encrypt: cipher.encrypt,
    decrypt: cipher.decrypt,
  })

  let provisioned = null
  const child = fakeChild(4321)
  const spawnImpl = (cmd, args) => {
    assert.equal(cmd, binaryPath)
    assert.deepEqual(args, ['tunnel', '--no-autoupdate', 'run', '--token', 'run-token'])
    return child
  }
  const manager = new CloudflareTunnelManager({
    store,
    userDataPath,
    appBinsDir,
    platform: 'darwin',
    arch: 'arm64',
    spawnImpl,
    provisionImpl: async (input) => {
      provisioned = input
      return { tunnelId: 'tunnel-9', hostname: 'sync.example.com', runToken: 'run-token', accountId: 'acct-1' }
    },
    isAlive: (pid) => pid === 4321,
  })

  assert.equal(manager.binaryInstalled(), true)
  const result = await manager.setup({
    domain: 'example.com',
    hostname: 'sync.example.com',
    apiToken: 'api-token',
  })

  assert.deepEqual(result, { hostname: 'sync.example.com', url: 'https://sync.example.com' })
  assert.equal(provisioned.token, 'api-token')
  assert.equal(provisioned.hostname, 'sync.example.com')
  assert.equal(manager.status().configured, true)
  assert.equal(manager.status().running, true)
  assert.equal(manager.status().pid, 4321)

  manager.stop()
  assert.equal(child.killed, true)
  assert.equal(manager.status().pid, null)
})

test('manager fails closed when cloudflared cannot be installed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-tunnel-manager-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createCloudflareTunnelStore({ filePath: join(root, 'unused.json') })
  const manager = new CloudflareTunnelManager({
    store,
    userDataPath: join(root, 'user-data'),
    appBinsDir: join(root, 'bins'),
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
    provisionImpl: async () => { throw new Error('should not provision') },
  })

  assert.equal(manager.binaryInstalled(), false)
  await assert.rejects(
    () => manager.setup({ domain: 'example.com', hostname: 'sync.example.com', apiToken: 'api-token' }),
    (error) => error.code === 'cloudflared_download_failed',
  )
})

test('manager installs the Windows cloudflared binary directly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-tunnel-manager-win-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appBinsDir = join(root, 'bins')
  const store = createCloudflareTunnelStore({ filePath: join(root, 'unused.json') })
  const manager = new CloudflareTunnelManager({
    store,
    userDataPath: join(root, 'user-data'),
    appBinsDir,
    platform: 'win32',
    arch: 'x64',
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('win-binary').buffer }),
  })

  const binaryPath = await manager.ensureBinary()
  assert.equal(binaryPath, join(appBinsDir, 'cloudflared.exe'))
  assert.equal(manager.binaryInstalled(), true)
})

test('quick tunnel captures the printed URL and persists enablement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-tunnel-manager-quick-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appBinsDir = join(root, 'bins')
  const userDataPath = join(root, 'user-data')
  mkdirSync(appBinsDir, { recursive: true })
  mkdirSync(userDataPath, { recursive: true })
  const binaryPath = join(appBinsDir, 'cloudflared')
  writeFileSync(binaryPath, 'fake binary')
  chmodSync(binaryPath, 0o755)

  const store = createCloudflareTunnelStore({ filePath: join(userDataPath, 'tunnel.json') })
  const child = fakeQuickChild(6789, 'INF Your quick Tunnel has been created: https://fast-trail-xxxx.trycloudflare.com')
  const manager = new CloudflareTunnelManager({
    store,
    userDataPath,
    appBinsDir,
    platform: 'darwin',
    arch: 'arm64',
    spawnImpl: (cmd, args) => {
      assert.equal(cmd, binaryPath)
      assert.deepEqual(args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:43122'])
      return child
    },
    isAlive: (pid) => pid === 6789,
  })

  assert.equal(manager.quickEnabled(), false)
  const result = await manager.startQuick({ grantMs: 250 })
  assert.deepEqual(result, { running: true, url: 'https://fast-trail-xxxx.trycloudflare.com' })
  assert.equal(manager.quickEnabled(), true)
  assert.equal(manager.quickStatus().running, true)
  assert.equal(manager.status().quick.url, 'https://fast-trail-xxxx.trycloudflare.com')

  manager.stopQuick({ disable: true })
  assert.equal(child.killed, true)
  assert.equal(manager.quickEnabled(), false)
  assert.equal(manager.quickStatus().running, false)
})

test('a relaunched shell reattaches to the persisted quick tunnel instead of republishing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-tunnel-manager-reconnect-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appBinsDir = join(root, 'bins')
  const userDataPath = join(root, 'user-data')
  mkdirSync(appBinsDir, { recursive: true })
  mkdirSync(userDataPath, { recursive: true })
  const binaryPath = join(appBinsDir, 'cloudflared')
  writeFileSync(binaryPath, 'fake binary')
  chmodSync(binaryPath, 0o755)

  const store = createCloudflareTunnelStore({ filePath: join(userDataPath, 'tunnel.json') })
  const expectations = { spawns: 0, lastArgs: null }
  const spawnImpl = (cmd, args) => {
    expectations.spawns += 1
    expectations.lastArgs = args
    return fakeQuickChild(6789, 'INF Your quick Tunnel has been created: https://steady-url-xxxx.trycloudflare.com')
  }
  const shared = {
    store,
    userDataPath,
    appBinsDir,
    platform: 'darwin',
    arch: 'arm64',
    spawnImpl,
    isAlive: (pid) => pid === 6789,
  }

  // First launch publishes and persists a URL.
  const first = new CloudflareTunnelManager(shared)
  const started = await first.startQuick({ grantMs: 250 })
  assert.equal(started.url, 'https://steady-url-xxxx.trycloudflare.com')
  assert.equal(expectations.spawns, 1)

  // "Relaunch": a brand-new manager reads the persisted pid+url and reattaches
  // without calling cloudflared at all, so the URL does not rotate.
  const second = new CloudflareTunnelManager(shared)
  const reattached = await second.startQuick({ grantMs: 250 })
  assert.deepEqual(reattached, { running: true, url: 'https://steady-url-xxxx.trycloudflare.com' })
  assert.equal(expectations.spawns, 1)
  assert.equal(second.quickEnabled(), true)
  assert.equal(second.quickStatus().url, 'https://steady-url-xxxx.trycloudflare.com')
})

test('stopQuick can signal a reattached tunnel from a previous shell', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-tunnel-manager-kill-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appBinsDir = join(root, 'bins')
  const userDataPath = join(root, 'user-data')
  mkdirSync(appBinsDir, { recursive: true })
  mkdirSync(userDataPath, { recursive: true })
  const binaryPath = join(appBinsDir, 'cloudflared')
  writeFileSync(binaryPath, 'fake binary')
  chmodSync(binaryPath, 0o755)

  const store = createCloudflareTunnelStore({ filePath: join(userDataPath, 'tunnel.json') })
  const killed = []
  const manager = new CloudflareTunnelManager({
    store,
    userDataPath,
    appBinsDir,
    platform: 'darwin',
    arch: 'arm64',
    spawnImpl: () => fakeQuickChild(6789, 'INF Your quick Tunnel has been created: https://kill-me-xxxx.trycloudflare.com'),
    isAlive: (pid) => pid === 6789,
    kill: (pid) => { killed.push(pid) },
  })

  assert.deepEqual(await manager.startQuick({ grantMs: 250 }), { running: true, url: 'https://kill-me-xxxx.trycloudflare.com' })

  // Simulate a relaunch that reattaches to the detached pid (no child handle).
  const second = new CloudflareTunnelManager({
    store,
    userDataPath,
    appBinsDir,
    platform: 'darwin',
    arch: 'arm64',
    spawnImpl: () => fakeQuickChild(9999, ''),
    isAlive: (pid) => pid === 6789,
    kill: (pid) => { killed.push(pid) },
  })
  assert.equal(second.quickStatus().running, true)
  second.stopQuick({ disable: true })
  assert.deepEqual(killed, [6789])
  assert.equal(second.quickEnabled(), false)
})

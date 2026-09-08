import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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

test('tunnel store round-trips identity and encrypted credentials', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-tunnel-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'ensync-cloudflare-tunnel-v1.json')
  const cipher = pseudoCipher()
  const store = createCloudflareTunnelStore({ filePath, encrypt: cipher.encrypt, decrypt: cipher.decrypt })

  assert.equal(store.identity(), null)
  const saved = store.save({
    hostname: 'sync.example.com',
    tunnelId: 'tunnel-9',
    accountId: 'acct-1',
    apiToken: 'api-token',
    runToken: 'run-token',
    pid: 42,
  })
  assert.deepEqual(saved, { hostname: 'sync.example.com', tunnelId: 'tunnel-9', accountId: 'acct-1', pid: 42 })

  const restored = createCloudflareTunnelStore({ filePath, encrypt: cipher.encrypt, decrypt: cipher.decrypt })
  assert.deepEqual(restored.identity(), saved)
  assert.deepEqual(restored.credentials(), { apiToken: 'api-token', runToken: 'run-token' })

  // Secrets are not written in plaintext.
  const encoded = await readFile(filePath, 'utf8')
  assert.equal(encoded.includes('api-token'), false)
  assert.equal(encoded.includes('run-token'), false)
})

test('tunnel store updates the liveness pid without rewriting secrets in plaintext', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-tunnel-store-pid-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'ensync-cloudflare-tunnel-v1.json')
  const cipher = pseudoCipher()
  const store = createCloudflareTunnelStore({ filePath, encrypt: cipher.encrypt, decrypt: cipher.decrypt })

  store.save({
    hostname: 'sync.example.com',
    tunnelId: 'tunnel-9',
    accountId: 'acct-1',
    apiToken: 'api-token',
    runToken: 'run-token',
  })
  store.setPid(99)
  assert.equal(store.identity().pid, 99)
  assert.deepEqual(store.credentials(), { apiToken: 'api-token', runToken: 'run-token' })

  const raw = await readFile(filePath, 'utf8')
  assert.equal(raw.includes('api-token'), false)
})

test('tunnel store recovers from a corrupt primary using the backup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-tunnel-store-backup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'ensync-cloudflare-tunnel-v1.json')
  const cipher = pseudoCipher()
  const store = createCloudflareTunnelStore({ filePath, encrypt: cipher.encrypt, decrypt: cipher.decrypt })
  store.save({
    hostname: 'sync.example.com',
    tunnelId: 'tunnel-9',
    accountId: 'acct-1',
    apiToken: 'api-token',
    runToken: 'run-token',
  })
  store.save({
    hostname: 'sync2.example.com',
    tunnelId: 'tunnel-10',
    accountId: 'acct-1',
    apiToken: 'api-token-2',
    runToken: 'run-token-2',
  })
  await writeFile(filePath, '{corrupt', 'utf8')

  assert.deepEqual(createCloudflareTunnelStore({ filePath, encrypt: cipher.encrypt, decrypt: cipher.decrypt }).identity(), {
    hostname: 'sync.example.com',
    tunnelId: 'tunnel-9',
    accountId: 'acct-1',
    pid: null,
  })
})

test('tunnel store clears persisted state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-tunnel-store-clear-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'ensync-cloudflare-tunnel-v1.json')
  const cipher = pseudoCipher()
  const store = createCloudflareTunnelStore({ filePath, encrypt: cipher.encrypt, decrypt: cipher.decrypt })
  store.save({
    hostname: 'sync.example.com',
    tunnelId: 'tunnel-9',
    accountId: 'acct-1',
    apiToken: 'api-token',
    runToken: 'run-token',
  })
  store.clear()
  assert.equal(createCloudflareTunnelStore({ filePath, encrypt: cipher.encrypt, decrypt: cipher.decrypt }).identity(), null)
})

test('tunnel store validates identity and credential inputs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-tunnel-store-invalid-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createCloudflareTunnelStore({ filePath: join(dir, 'ensync-cloudflare-tunnel-v1.json') })
  assert.throws(() => store.save({ hostname: 'x' }), /identity/)
  assert.throws(
    () => store.save({ hostname: 'sync.example.com', tunnelId: 't-1', apiToken: '', runToken: 'r' }),
    /API token/,
  )
})

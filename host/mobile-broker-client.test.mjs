import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { AccountSyncService } from './account-sync.mjs'
import { BrokerClient } from '../mobile/src/broker-client.js'
import { createEnsyncSyncServer, MemorySyncStore } from '../sync-service/server.mjs'

function installMemoryStorage() {
  const values = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key) { return values.get(key) ?? null },
      setItem(key, value) { values.set(key, String(value)) },
      removeItem(key) { values.delete(key) },
    },
  })
}

test('mobile WebCrypto client interoperates with the Host broker encryption context', async (context) => {
  installMemoryStorage()
  const server = createEnsyncSyncServer({ store: new MemorySyncStore() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const credentials = { username: 'mobile-crypto', password: 'a strong mobile encryption password' }
  const host = new AccountSyncService({ baseUrl })
  await host.register(credentials)
  await host.registerBrokerDevice({
    deviceId: 'host_mobile_crypto_0001',
    role: 'host',
    label: 'Test Host',
  })
  const pairing = await host.createBrokerPairing()

  const mobile = new BrokerClient(baseUrl)
  await mobile.authenticate('login', credentials.username, credentials.password)
  const claimed = await mobile.claimPairing(pairing.code)
  const submitted = await mobile.submit({
    hostId: claimed.host.id,
    provider: 'codex',
    projectPath: '/verified/mobile/project',
    prompt: 'Run this from iPhone.',
  })

  const [received] = await host.pollBrokerHostJobs()
  assert.equal(received.id, submitted.id)
  assert.deepEqual(received.request, {
    provider: 'codex',
    projectPath: '/verified/mobile/project',
    prompt: 'Run this from iPhone.',
    workspaceKey: `sync:${mobile.deviceId}:${submitted.id}`,
  })

  await host.claimBrokerJob(received)
  await host.publishBrokerEvent(received, {
    type: 'completed',
    result: { response: 'Delivered to mobile.' },
    at: '2026-08-08T12:00:00.000Z',
    sequence: 1,
  })
  const completed = await mobile.job(submitted.id)
  assert.equal(completed.state, 'completed')
  assert.equal(completed.events[0].result.response, 'Delivered to mobile.')
})

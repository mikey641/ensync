import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { AccountSyncService } from './account-sync.mjs'
import { ChatJobService } from './chat-jobs.mjs'
import { SyncBrokerHostWorker } from './sync-broker-host.mjs'
import { createEnsyncSyncServer, MemorySyncStore } from '../sync-service/server.mjs'

async function eventually(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await check()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError ?? new Error('Condition was not reached.')
}

async function brokerFixture(context, chatJobs) {
  const store = new MemorySyncStore()
  const server = createEnsyncSyncServer({ store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const credentials = { username: 'broker-worker', password: 'a secure broker worker password' }
  const hostAccount = new AccountSyncService({ baseUrl })
  const client = new AccountSyncService({ baseUrl })
  await hostAccount.register(credentials)
  await client.login(credentials)
  const worker = new SyncBrokerHostWorker({
    accountSyncService: hostAccount,
    chatJobService: chatJobs,
    pollIntervalMs: 60_000,
  })
  context.after(() => worker.stop())
  await worker.connect({ deviceId: 'host_worker_000000001', label: 'Paired worker' })
  const pairing = await worker.createPairing()
  await client.registerBrokerDevice({
    deviceId: 'mobile_client_0000001',
    role: 'client',
    label: 'Android',
  })
  const claimed = await client.claimBrokerPairing(pairing.code)
  return { store, hostAccount, client, worker, hostId: claimed.host.id }
}

test('outbound Host worker executes an encrypted broker job exactly once and relays sequenced events', async (context) => {
  let runs = 0
  const chatJobs = new ChatJobService({
    runLocal: async (request, options) => {
      runs += 1
      options.onEvent({ type: 'started', provider: request.provider, at: '2026-08-08T11:00:00.000Z' })
      return { provider: request.provider, response: `Finished ${request.prompt}`, sessionId: null, usage: null }
    },
    runRemote: async () => ({ response: 'unused' }),
  })
  const { store, client, worker, hostId } = await brokerFixture(context, chatJobs)
  const submitted = await client.submitBrokerJob({
    hostId,
    jobId: 'job_worker_0000000001',
    kind: 'local',
    request: { provider: 'codex', projectPath: '/verified/project', prompt: 'from mobile' },
  })

  await worker.pollOnce()
  const completed = await eventually(async () => {
    await worker.pollOnce()
    const status = await client.brokerJob(submitted.id)
    assert.equal(status.state, 'completed')
    return status
  })
  await worker.pollOnce()

  assert.equal(runs, 1)
  assert.deepEqual(completed.events.map((item) => item.event.type), ['started', 'completed'])
  assert.equal(completed.events[1].event.result.response, 'Finished from mobile')
  assert.equal(JSON.stringify(store.data).includes('from mobile'), false)
})

test('claimed broker jobs without a matching durable Host job are reconciled and never replayed', async (context) => {
  let runs = 0
  const chatJobs = new ChatJobService({
    runLocal: async () => {
      runs += 1
      return { response: 'must not execute' }
    },
    runRemote: async () => ({ response: 'unused' }),
  })
  const { hostAccount, client, worker, hostId } = await brokerFixture(context, chatJobs)
  const submitted = await client.submitBrokerJob({
    hostId,
    jobId: 'job_worker_0000000002',
    kind: 'local',
    request: { provider: 'codex', projectPath: '/verified/project', prompt: 'ambiguous delivery' },
  })
  const [queued] = await hostAccount.pollBrokerHostJobs()
  const claimed = await hostAccount.claimBrokerJob(queued)
  assert.equal(claimed.newlyClaimed, true)

  await worker.pollOnce()
  const reconciled = await eventually(async () => {
    await worker.pollOnce()
    const status = await client.brokerJob(submitted.id)
    assert.equal(status.state, 'reconciliation_required')
    return status
  })

  assert.equal(runs, 0)
  assert.equal(reconciled.events.at(-1).event.code, 'broker_job_reconciliation_required')
  assert.equal(reconciled.events.at(-1).event.safeToRetry, false)
})

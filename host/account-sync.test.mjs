import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { AccountSyncError, AccountSyncService, normalizeAccountSyncServiceUrl } from './account-sync.mjs'
import { createEnsyncSyncServer, MemorySyncStore } from '../sync-service/server.mjs'

async function fixture(context, options = {}) {
  const store = new MemorySyncStore()
  const server = createEnsyncSyncServer({ store, ...options })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  return {
    store,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

test('mobile origins receive narrow broker CORS permissions', async (context) => {
  const { baseUrl } = await fixture(context)
  const preflight = await fetch(`${baseUrl}/v1/broker/jobs`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'capacitor://localhost',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,x-ensync-device-id,x-ensync-device-token',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'capacitor://localhost')
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Ensync-Device-Token/i)

  const denied = await fetch(`${baseUrl}/v1/status`, {
    headers: { Origin: 'https://untrusted.example' },
  })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).code, 'origin_not_allowed')
})

test('account sync requires HTTPS except for an exact loopback development service', () => {
  assert.equal(normalizeAccountSyncServiceUrl('http://127.0.0.1:43122/'), 'http://127.0.0.1:43122')
  assert.equal(normalizeAccountSyncServiceUrl('https://sync.ensync.example/v1/'), 'https://sync.ensync.example/v1')
  assert.throws(
    () => normalizeAccountSyncServiceUrl('http://sync.ensync.example'),
    (error) => error instanceof AccountSyncError && error.code === 'sync_configuration_invalid',
  )
})

test('username login synchronizes an encrypted conversation document between computers', async (context) => {
  const { store, baseUrl } = await fixture(context)
  const firstComputer = new AccountSyncService({ baseUrl })
  const secondComputer = new AccountSyncService({ baseUrl })
  const credentials = { username: 'mikey.sync', password: 'correct horse battery staple' }

  const registered = await firstComputer.register(credentials)
  assert.equal(registered.authenticated, true)
  assert.equal(registered.username, 'mikey.sync')
  assert.equal(registered.credentialStorage, 'host_memory_only')

  const state = {
    format: 'ensync-account-conversations',
    version: 1,
    chats: [{ id: 'chat-a', title: 'Private planning chat', messages: [] }],
    projects: [],
  }
  assert.deepEqual(await firstComputer.pull(), { state: null, revision: 0, updatedAt: null })
  const saved = await firstComputer.push(state, 0)
  assert.equal(saved.status, 'saved')
  assert.equal(saved.revision, 1)

  const remoteBytes = JSON.stringify(store.data)
  assert.equal(remoteBytes.includes('Private planning chat'), false)
  assert.equal(remoteBytes.includes('correct horse battery staple'), false)

  await secondComputer.login(credentials)
  const downloaded = await secondComputer.pull()
  assert.equal(downloaded.revision, 1)
  assert.deepEqual(downloaded.state, state)
})

test('concurrent account changes return the decryptable newer document for a safe merge', async (context) => {
  const { baseUrl } = await fixture(context)
  const credentials = { username: 'team-user', password: 'a long password for sync' }
  const first = new AccountSyncService({ baseUrl })
  const second = new AccountSyncService({ baseUrl })
  await first.register(credentials)
  await second.login(credentials)
  await first.pull()
  await second.pull()

  const firstState = { format: 'ensync-account-conversations', version: 1, chats: [{ id: 'first' }], projects: [] }
  const secondState = { format: 'ensync-account-conversations', version: 1, chats: [{ id: 'second' }], projects: [] }
  assert.equal((await first.push(firstState, 0)).status, 'saved')
  const conflict = await second.push(secondState, 0)

  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.revision, 1)
  assert.deepEqual(conflict.remoteState, firstState)
})

test('invalid login does not reveal whether a username exists', async (context) => {
  const { baseUrl } = await fixture(context)
  const service = new AccountSyncService({ baseUrl })
  await service.register({ username: 'private-user', password: 'a valid account password' })
  const attempt = new AccountSyncService({ baseUrl })

  await assert.rejects(
    () => attempt.login({ username: 'private-user', password: 'the wrong account password' }),
    (error) => error instanceof AccountSyncError
      && error.code === 'login_failed'
      && error.message === 'The username or password is incorrect.',
  )
})

async function pairedBrokerFixture(context) {
  const { store, baseUrl } = await fixture(context)
  const credentials = { username: 'remote-agents', password: 'a strong remote execution password' }
  const host = new AccountSyncService({ baseUrl })
  const client = new AccountSyncService({ baseUrl })
  await host.register(credentials)
  await client.login(credentials)
  await host.registerBrokerDevice({
    deviceId: 'host_device_00000001',
    role: 'host',
    label: 'Development Mac',
  })
  const pairing = await host.createBrokerPairing()
  await client.registerBrokerDevice({
    deviceId: 'client_device_000001',
    role: 'client',
    label: 'iPhone',
  })
  const claimed = await client.claimBrokerPairing(pairing.code)
  return { store, host, client, claimed }
}

test('paired clients submit opaque remote jobs that only the selected Host decrypts and executes', async (context) => {
  const { store, host, client, claimed } = await pairedBrokerFixture(context)
  assert.equal(claimed.host.id, 'host_device_00000001')
  assert.deepEqual((await client.listBrokerHosts()).map((item) => item.id), ['host_device_00000001'])

  const submitted = await client.submitBrokerJob({
    hostId: claimed.host.id,
    jobId: 'job_remote_0000000001',
    kind: 'local',
    request: {
      provider: 'codex',
      projectPath: '/verified/project',
      prompt: 'private mobile instruction',
    },
  })
  assert.equal(submitted.state, 'queued')
  const stored = JSON.stringify(store.data)
  assert.equal(stored.includes('private mobile instruction'), false)
  assert.equal(stored.includes('/verified/project'), false)

  const [queued] = await host.pollBrokerHostJobs()
  assert.equal(queued.id, submitted.id)
  assert.equal(queued.kind, 'local')
  assert.equal(queued.request.prompt, 'private mobile instruction')
  await host.claimBrokerJob(queued)
  await host.publishBrokerEvent(queued, {
    type: 'started',
    provider: 'codex',
    at: '2026-08-08T10:00:00.000Z',
    sequence: 1,
  })
  await host.publishBrokerEvent(queued, {
    type: 'completed',
    result: { response: 'private completed response' },
    at: '2026-08-08T10:00:01.000Z',
    sequence: 2,
  })
  assert.equal(JSON.stringify(store.data).includes('private completed response'), false)

  const completed = await client.brokerJob(submitted.id)
  assert.equal(completed.state, 'completed')
  assert.deepEqual(completed.events.map((item) => item.event.type), ['started', 'completed'])
  assert.equal(completed.events[1].event.result.response, 'private completed response')

  const duplicate = await client.submitBrokerJob({
    hostId: claimed.host.id,
    jobId: 'job_remote_0000000001',
    kind: 'local',
    request: {
      provider: 'codex',
      projectPath: '/verified/project',
      prompt: 'private mobile instruction',
    },
  })
  assert.equal(duplicate.id, submitted.id)
  assert.equal(Object.keys(store.data.accounts['remote-agents'].broker.jobs).length, 1)
})

test('paired clients send encrypted control commands with exact Host acknowledgements', async (context) => {
  const { store, host, client, claimed } = await pairedBrokerFixture(context)
  const submitted = await client.submitBrokerJob({
    hostId: claimed.host.id,
    jobId: 'job_remote_0000000002',
    kind: 'local',
    request: { provider: 'codex', projectPath: '/verified/project', prompt: 'Start.' },
  })
  const [queued] = await host.pollBrokerHostJobs()
  await host.claimBrokerJob(queued)
  const command = await client.sendBrokerCommand(submitted, 'steer', { prompt: 'secret correction' })
  assert.equal(JSON.stringify(store.data).includes('secret correction'), false)

  const [received] = await host.pollBrokerCommands(queued)
  assert.equal(received.id, command.id)
  assert.equal(received.type, 'steer')
  assert.deepEqual(received.payload, { prompt: 'secret correction' })
  await host.acknowledgeBrokerCommand(queued, received, { delivered: true, turnId: 'turn-1' })

  const status = await client.brokerJob(submitted.id)
  assert.deepEqual(status.commands[0].acknowledgement, {
    version: 1,
    acknowledgement: { delivered: true, turnId: 'turn-1' },
  })

  await client.revokeBrokerPairing(claimed.id)
  await assert.rejects(
    () => client.submitBrokerJob({
      hostId: claimed.host.id,
      jobId: 'job_remote_0000000003',
      kind: 'local',
      request: { provider: 'codex', projectPath: '/verified/project', prompt: 'Must not run.' },
    }),
    (error) => error instanceof AccountSyncError && error.code === 'broker_host_not_paired',
  )
})

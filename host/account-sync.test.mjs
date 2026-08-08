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

test('authenticated computers receive workspace revisions over the live stream', async (context) => {
  const { baseUrl } = await fixture(context)
  const credentials = { username: 'live-user', password: 'a secure live account password' }
  const firstComputer = new AccountSyncService({ baseUrl })
  const secondComputer = new AccountSyncService({ baseUrl })
  await firstComputer.register(credentials)
  await secondComputer.login(credentials)
  await secondComputer.pull()

  const controller = new AbortController()
  context.after(() => controller.abort())
  let openedResolve
  const opened = new Promise((resolve) => { openedResolve = resolve })
  let updatedResolve
  const updated = new Promise((resolve) => { updatedResolve = resolve })
  const events = []
  const subscription = secondComputer.subscribe({
    signal: controller.signal,
    afterRevision: 0,
    onOpen: openedResolve,
    onEvent: (event) => {
      events.push(event)
      if (event.type === 'workspace_updated') updatedResolve(event)
    },
  })

  await opened
  const saved = await firstComputer.push({
    format: 'ensync-account-conversations',
    version: 1,
    chats: [{ id: 'chat-live', title: 'Arrives now', messages: [] }],
    projects: [],
  }, 0)
  const event = await Promise.race([
    updated,
    new Promise((_, reject) => setTimeout(() => reject(new Error('live update timed out')), 1_000)),
  ])

  assert.equal(saved.revision, 1)
  assert.equal(event.revision, 1)
  assert.equal(events[0].type, 'connected')
  controller.abort()
  await subscription
})

test('live workspace stream requires an authenticated account session', async (context) => {
  const { baseUrl } = await fixture(context)
  const response = await fetch(`${baseUrl}/v1/events`)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'login_required')
})

test('the username session authorizes server-owned execution without exposing the Host token', async (context) => {
  const executionRequests = []
  const executionServer = (await import('node:http')).createServer((request, response) => {
    executionRequests.push({ url: request.url, authorization: request.headers.authorization })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ providers: [{ id: 'codex', executionTarget: 'account-server' }] }))
  })
  executionServer.listen(0, '127.0.0.1')
  await once(executionServer, 'listening')
  context.after(() => executionServer.close())
  const executionAddress = executionServer.address()
  assert.equal(typeof executionAddress, 'object')
  const { baseUrl } = await fixture(context, {
    executionOrigin: `http://127.0.0.1:${executionAddress.port}`,
    executionToken: 'internal-host-token',
  })

  const unauthorized = await fetch(`${baseUrl}/api/providers`)
  assert.equal(unauthorized.status, 401)

  const account = new AccountSyncService({ baseUrl })
  await account.register({ username: 'server-owner', password: 'a strong server account password' })
  const response = await account.executionRequest('/api/providers')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).providers[0].executionTarget, 'account-server')
  assert.deepEqual(executionRequests, [{
    url: '/api/providers',
    authorization: 'Bearer internal-host-token',
  }])
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

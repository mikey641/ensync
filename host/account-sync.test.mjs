import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { AccountSyncError, AccountSyncService, normalizeAccountSyncServiceUrl } from './account-sync.mjs'
import { createEnsyncSyncServer, MemorySyncStore } from '../sync-service/server.mjs'

async function fixture(context) {
  const store = new MemorySyncStore()
  const server = createEnsyncSyncServer({ store })
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

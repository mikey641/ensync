import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
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

test('account sync reports its configured service URL', () => {
  const configured = new AccountSyncService({ baseUrl: 'https://sync.ensync.example' })
  assert.equal(configured.status().configured, true)
  assert.equal(configured.status().serviceUrl, 'https://sync.ensync.example')

  const unconfigured = new AccountSyncService()
  assert.equal(unconfigured.status().configured, false)
  assert.equal(unconfigured.status().serviceUrl, null)
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
  assert.equal(registered.serviceUrl, baseUrl)

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

function totp(secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / 30)
  const counterBytes = Buffer.alloc(8)
  counterBytes.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(counterBytes).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  return String(binary % 1_000_000).padStart(6, '0')
}

async function post(baseUrl, path, body, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function get(baseUrl, path, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  return { status: response.status, body: await response.json() }
}

test('account registration enforces a stronger password', async (context) => {
  const { baseUrl } = await fixture(context)
  const weak = await post(baseUrl, '/v1/accounts', { username: 'weak-user', password: 'password1234567' })
  assert.equal(weak.status, 400)
  assert.equal(weak.body.code, 'password_weak')

  const strong = await post(baseUrl, '/v1/accounts', {
    username: 'strong-user',
    password: 'correct horse battery staple',
    email: 'User@Example.com ',
  })
  assert.equal(strong.status, 201)
  assert.equal(strong.body.email, 'user@example.com')
})

test('an email address works as the account identifier', async (context) => {
  const { baseUrl } = await fixture(context)
  const registered = await post(baseUrl, '/v1/accounts', {
    username: 'Mikey641@Gmail.com',
    password: 'correct horse battery staple',
  })
  assert.equal(registered.status, 201)
  assert.equal(registered.body.username, 'mikey641@gmail.com')

  const signedIn = await post(baseUrl, '/v1/sessions', {
    username: 'mikey641@gmail.com',
    password: 'correct horse battery staple',
  })
  assert.equal(signedIn.status, 200)
  assert.equal(signedIn.body.username, 'mikey641@gmail.com')

  const rejected = await post(baseUrl, '/v1/accounts', { username: 'mail@box', password: 'correct horse battery staple' })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.code, 'username_invalid')
})

test('TOTP second factor, recovery codes, and email round-trip', async (context) => {
  const { baseUrl } = await fixture(context)
  const password = 'correct horse battery staple'
  const registered = await post(baseUrl, '/v1/accounts', { username: 'totp-user', password })
  const token = registered.body.token

  const account = await get(baseUrl, '/v1/account', token)
  assert.equal(account.status, 200)
  assert.equal(account.body.twoFactorEnabled, false)
  assert.equal(account.body.email, null)

  const email = await post(baseUrl, '/v1/account/email', { email: 'owner@example.com' }, token)
  assert.equal(email.status, 200)
  assert.equal(email.body.email, 'owner@example.com')

  const start = await post(baseUrl, '/v1/account/totp/start', {}, token)
  assert.equal(start.status, 200)
  assert.match(start.body.uri, /^otpauth:\/\/totp\//)

  const confirmed = await post(baseUrl, '/v1/account/totp/confirm', {
    challengeId: start.body.challengeId,
    code: totp(start.body.secret),
  }, token)
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.body.recoveryCodes.length, 8)

  // Login now enters a second-factor stage instead of issuing a session.
  const wrongStage = await post(baseUrl, '/v1/sessions', { username: 'totp-user', password })
  assert.equal(wrongStage.status, 200)
  assert.equal(wrongStage.body.stage, 'second_factor')

  const badCode = await post(baseUrl, '/v1/sessions/verify', {
    challengeId: wrongStage.body.challengeId,
    code: '000000',
  })
  assert.equal(badCode.status, 401)

  const challenge = await post(baseUrl, '/v1/sessions', { username: 'totp-user', password })
  const verified = await post(baseUrl, '/v1/sessions/verify', {
    challengeId: challenge.body.challengeId,
    code: totp(start.body.secret),
  })
  assert.equal(verified.status, 200)
  assert.equal(verified.body.username, 'totp-user')
  assert.equal(typeof verified.body.encryptionSalt, 'string')

  // A recovery code both signs in and disables 2FA.
  const recoveryChallenge = await post(baseUrl, '/v1/sessions', { username: 'totp-user', password })
  const recovered = await post(baseUrl, '/v1/sessions/verify', {
    challengeId: recoveryChallenge.body.challengeId,
    recoveryCode: confirmed.body.recoveryCodes[0],
  })
  assert.equal(recovered.status, 200)
  assert.equal(recovered.body.twoFactorDisabled, true)

  const after = await get(baseUrl, '/v1/account', recovered.body.token)
  assert.equal(after.body.twoFactorEnabled, false)
  assert.equal(after.body.recoveryRemaining, 7)
})

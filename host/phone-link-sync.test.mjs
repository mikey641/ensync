import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { createEnsyncSyncServer, MemorySyncStore } from '../sync-service/server.mjs'

const PWA_ORIGIN = 'https://ensync.vercel.app'

async function startSyncServer(context, options = {}) {
  const store = new MemorySyncStore()
  const server = createEnsyncSyncServer({ store, allowedOrigins: PWA_ORIGIN, ...options })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  }))
  return { store, base: `http://127.0.0.1:${server.address().port}` }
}

async function call(base, path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers ?? {}) }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  if (options.deviceId) headers['X-Ensync-Device-Id'] = options.deviceId
  if (options.deviceToken) headers['X-Ensync-Device-Token'] = options.deviceToken
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return { status: response.status, headers: response.headers, payload: await response.json().catch(() => ({})) }
}

const document = (marker) => ({
  version: 1,
  algorithm: 'aes-256-gcm',
  iv: 'aaaaaaaaaaaaaaaa',
  tag: 'bbbbbbbbbbbbbbbbbbbbbb',
  ciphertext: marker,
})

async function signedInHost(base) {
  const account = await call(base, '/v1/accounts', {
    method: 'POST',
    body: { username: 'phone-owner', password: 'Phone-Link-Owner-Password-42!' },
  })
  assert.equal(account.status, 201)
  const hostId = 'host_0123456789abcdef'
  const host = await call(base, '/v1/broker/devices', {
    method: 'POST',
    token: account.payload.token,
    body: { deviceId: hostId, role: 'host', label: 'studio' },
  })
  assert.equal(host.status, 201)
  return { token: account.payload.token, hostId, hostToken: host.payload.token }
}

test('a QR link token is single use, pairs a client, and yields a working session and device token', async (context) => {
  const { base, store } = await startSyncServer(context)
  const owner = await signedInHost(base)

  const created = await call(base, '/v1/broker/links', { method: 'POST', token: owner.token, body: { hostId: owner.hostId } })
  assert.equal(created.status, 201)
  assert.equal(typeof created.payload.token, 'string')
  assert.ok(Date.parse(created.payload.expiresAt) > Date.now() + 9 * 60_000)
  assert.ok(!JSON.stringify(store.read()).includes(created.payload.token), 'link token is stored hashed')

  const phoneId = 'phone_0123456789abcdef'
  const claimed = await call(base, '/v1/broker/links/claim', {
    method: 'POST',
    headers: { Origin: PWA_ORIGIN },
    body: { token: created.payload.token, deviceId: phoneId, label: 'Pixel' },
  })
  assert.equal(claimed.status, 200)
  assert.equal(claimed.headers.get('access-control-allow-origin'), PWA_ORIGIN)
  assert.equal(claimed.payload.username, 'phone-owner')
  assert.equal(claimed.payload.device.id, phoneId)
  assert.equal(claimed.payload.device.role, 'client')
  assert.equal(typeof claimed.payload.device.token, 'string')
  assert.equal(claimed.payload.host.id, owner.hostId)
  assert.equal(typeof claimed.payload.refreshToken, 'string')
  assert.ok(Date.parse(claimed.payload.session.expiresAt) > Date.now())
  assert.ok(!JSON.stringify(store.read()).includes(claimed.payload.refreshToken), 'refresh token is stored hashed')

  const again = await call(base, '/v1/broker/links/claim', {
    method: 'POST',
    body: { token: created.payload.token, deviceId: 'phone_other_0123456789', label: 'Other' },
  })
  assert.equal(again.status, 404)
  assert.equal(again.payload.code, 'broker_link_invalid')

  const workspace = await call(base, '/v1/workspace', { token: claimed.payload.session.token })
  assert.equal(workspace.status, 200)
  const hosts = await call(base, '/v1/broker/hosts', {
    token: claimed.payload.session.token,
    deviceId: phoneId,
    deviceToken: claimed.payload.device.token,
  })
  assert.equal(hosts.status, 200)
  assert.deepEqual(hosts.payload.hosts.map((host) => host.id), [owner.hostId])

  const linked = await call(base, '/v1/broker/pairings', {
    token: owner.token,
    deviceId: owner.hostId,
    deviceToken: owner.hostToken,
  })
  assert.equal(linked.status, 200)
  assert.deepEqual(linked.payload.pairings.map((pairing) => pairing.client.id), [phoneId])

  const phoneCannotLink = await call(base, '/v1/broker/links', {
    method: 'POST',
    token: claimed.payload.session.token,
    body: { hostId: owner.hostId },
  })
  assert.equal(phoneCannotLink.status, 403)
})

test('link creation requires a session that owns an active Host and expired links fail closed', async (context) => {
  const { base, store } = await startSyncServer(context)
  const owner = await signedInHost(base)
  assert.equal((await call(base, '/v1/broker/links', { method: 'POST', body: { hostId: owner.hostId } })).status, 401)
  const missing = await call(base, '/v1/broker/links', { method: 'POST', token: owner.token, body: { hostId: 'host_unknown_0123456789' } })
  assert.equal(missing.status, 409)

  const created = await call(base, '/v1/broker/links', { method: 'POST', token: owner.token, body: { hostId: owner.hostId } })
  const data = store.read()
  for (const link of Object.values(data.accounts['phone-owner'].broker.links)) link.expiresAt = new Date(Date.now() - 1000).toISOString()
  store.write(data)
  const expired = await call(base, '/v1/broker/links/claim', {
    method: 'POST',
    body: { token: created.payload.token, deviceId: 'phone_0123456789abcdef', label: 'Pixel' },
  })
  assert.equal(expired.status, 404)
})

test('refresh tokens keep a linked phone signed in until its pairing or device is revoked', async (context) => {
  const { base } = await startSyncServer(context)
  const owner = await signedInHost(base)
  const created = await call(base, '/v1/broker/links', { method: 'POST', token: owner.token, body: { hostId: owner.hostId } })
  const phoneId = 'phone_0123456789abcdef'
  const claimed = await call(base, '/v1/broker/links/claim', {
    method: 'POST',
    body: { token: created.payload.token, deviceId: phoneId, label: 'Pixel' },
  })

  const wrongDevice = await call(base, '/v1/sessions/refresh', {
    method: 'POST',
    body: { refreshToken: claimed.payload.refreshToken, deviceId: 'phone_other_0123456789' },
  })
  assert.equal(wrongDevice.status, 401)

  const refreshed = await call(base, '/v1/sessions/refresh', {
    method: 'POST',
    body: { refreshToken: claimed.payload.refreshToken, deviceId: phoneId },
  })
  assert.equal(refreshed.status, 200)
  assert.equal(typeof refreshed.payload.session.token, 'string')
  assert.equal((await call(base, '/v1/workspace', { token: refreshed.payload.session.token })).status, 200)

  const revoked = await call(base, '/v1/broker/pairings/revoke', {
    method: 'POST',
    token: owner.token,
    deviceId: owner.hostId,
    deviceToken: owner.hostToken,
    body: { pairingId: claimed.payload.pairing.id },
  })
  assert.equal(revoked.status, 200)

  const afterRevoke = await call(base, '/v1/sessions/refresh', {
    method: 'POST',
    body: { refreshToken: claimed.payload.refreshToken, deviceId: phoneId },
  })
  assert.equal(afterRevoke.status, 401)
  assert.equal(afterRevoke.payload.code, 'refresh_invalid')
  const sessionAfterRevoke = await call(base, '/v1/workspace', { token: refreshed.payload.session.token })
  assert.equal(sessionAfterRevoke.status, 401)
  assert.equal(sessionAfterRevoke.payload.code, 'device_revoked')
  // The owner's own password session is unaffected.
  assert.equal((await call(base, '/v1/workspace', { token: owner.token })).status, 200)
})

test('workspace wait returns immediately, wakes on a push, and times out unchanged', async (context) => {
  const { base } = await startSyncServer(context)
  const owner = await signedInHost(base)

  const timedOut = await call(base, '/v1/workspace/wait?after=0&timeout=0.2', { token: owner.token })
  assert.equal(timedOut.status, 200)
  assert.deepEqual(timedOut.payload, { revision: 0, changed: false })

  const waiting = call(base, '/v1/workspace/wait?after=0&timeout=10', { token: owner.token })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const started = Date.now()
  const pushed = await call(base, '/v1/workspace', {
    method: 'PUT',
    token: owner.token,
    body: { baseRevision: 0, document: document('first') },
  })
  assert.equal(pushed.status, 200)
  const woke = await waiting
  assert.ok(Date.now() - started < 2_000)
  assert.equal(woke.payload.changed, true)
  assert.equal(woke.payload.revision, 1)
  assert.equal(woke.payload.document.ciphertext, 'first')

  const immediate = await call(base, '/v1/workspace/wait?after=0', { token: owner.token })
  assert.equal(immediate.payload.revision, 1)
  assert.equal(immediate.payload.changed, true)

  assert.equal((await call(base, '/v1/workspace/wait?after=-1', { token: owner.token })).status, 400)
  assert.equal((await call(base, '/v1/workspace/wait?after=0')).status, 401)
})

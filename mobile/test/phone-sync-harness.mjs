// Test harness: wraps the bundled Ensync Sync service with the phone-sync
// endpoints from .ensync/features/phone-sync.md (link claim, session refresh,
// workspace long-poll) so the phone client can be exercised end to end before
// the real service implements them. It is NOT the production implementation:
// it proxies everything else to an unmodified `createEnsyncSyncServer`.

import { createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { promisify } from 'node:util'

import { createEnsyncSyncServer, MemorySyncStore } from '../../sync-service/server.mjs'

const scrypt = promisify(scryptCallback)
const LINK_LIFETIME_MS = 10 * 60 * 1000

function hash(value) {
  return createHash('sha256').update(value).digest('base64url')
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

export async function deriveAccountKey(password, encryptionSalt) {
  return scrypt(password, Buffer.from(encryptionSalt, 'base64url'), 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

export async function createPhoneSyncHarness({ store = new MemorySyncStore(), port = 0, waitSupported = true, sessionLifetimeMs = null } = {}) {
  const inner = createEnsyncSyncServer({ store })
  inner.listen(0, '127.0.0.1')
  await once(inner, 'listening')
  const innerUrl = `http://127.0.0.1:${inner.address().port}`
  const links = new Map()
  const refreshTokens = new Map()
  const accounts = new Map()
  const stats = { waits: 0, refreshes: 0, claims: 0 }

  async function innerJson(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${innerUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, json: await response.json().catch(() => ({})) }
  }

  async function login(username) {
    const account = accounts.get(username)
    const result = await innerJson('/v1/sessions', { method: 'POST', body: { username, password: account.password } })
    if (result.status !== 200) throw new Error(`harness login failed: ${JSON.stringify(result.json)}`)
    const expiresAt = sessionLifetimeMs === null ? Date.now() + 24 * 60 * 60 * 1000 : Date.now() + sessionLifetimeMs
    return { token: result.json.token, expiresAt: new Date(expiresAt).toISOString() }
  }

  function send(response, origin, status, payload) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    })
    response.end(JSON.stringify(payload))
  }

  async function proxy(request, response) {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const upstream = await fetch(`${innerUrl}${request.url}`, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).filter(([key]) => !['host', 'connection', 'content-length'].includes(key))),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    })
    const headers = {}
    upstream.headers.forEach((value, key) => { if (!['content-length', 'connection', 'transfer-encoding', 'keep-alive'].includes(key)) headers[key] = value })
    response.writeHead(upstream.status, headers)
    response.end(Buffer.from(await upstream.arrayBuffer()))
  }

  const outer = createServer(async (request, response) => {
    const origin = request.headers.origin
    const url = new URL(request.url, 'http://harness')
    try {
      if (request.method === 'POST' && url.pathname === '/v1/broker/links/claim') {
        const input = await readBody(request)
        const entry = links.get(hash(String(input.token ?? '')))
        if (!entry || entry.usedAt || entry.expiresAt < Date.now()) {
          return send(response, origin, 404, { error: 'This phone link is invalid, expired, or already used.', code: 'broker_link_invalid' })
        }
        entry.usedAt = Date.now()
        stats.claims += 1
        const session = await login(entry.username)
        const registration = await innerJson('/v1/broker/devices', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.token}` },
          body: { deviceId: input.deviceId, role: 'client', label: input.label || 'Phone' },
        })
        if (registration.status >= 300) return send(response, origin, registration.status, registration.json)
        const data = store.read()
        const broker = data.accounts[entry.username].broker
        const now = new Date().toISOString()
        const pairingId = `pair_${randomBytes(16).toString('base64url')}`
        broker.pairings[pairingId] = {
          id: pairingId, hostId: entry.hostId, clientId: input.deviceId, createdAt: now, expiresAt: now, claimedAt: now, revokedAt: null,
        }
        store.write(data)
        const host = broker.devices[entry.hostId]
        const refreshToken = randomBytes(32).toString('base64url')
        refreshTokens.set(hash(refreshToken), { username: entry.username, deviceId: input.deviceId })
        return send(response, origin, 200, {
          username: entry.username,
          session,
          refreshToken,
          device: { ...registration.json.device, token: registration.json.token },
          host: { id: host.id, role: host.role, label: host.label, lastSeenAt: host.lastSeenAt ?? null, capabilities: host.capabilities ?? null },
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/sessions/refresh') {
        const input = await readBody(request)
        const entry = refreshTokens.get(hash(String(input.refreshToken ?? '')))
        const device = entry ? store.read().accounts[entry.username]?.broker?.devices?.[entry.deviceId] : null
        if (!entry || entry.deviceId !== input.deviceId || !device || device.revokedAt) {
          return send(response, origin, 401, { error: 'This phone link was revoked.', code: 'refresh_invalid' })
        }
        stats.refreshes += 1
        return send(response, origin, 200, { session: await login(entry.username) })
      }

      if (request.method === 'GET' && url.pathname === '/v1/workspace/wait' && waitSupported) {
        stats.waits += 1
        const after = Number(url.searchParams.get('after') ?? 0)
        const timeout = Math.min(Number(url.searchParams.get('timeout') ?? 25), 25) * 1000
        const end = Date.now() + timeout
        for (;;) {
          const current = await innerJson('/v1/workspace', { headers: { Authorization: request.headers.authorization ?? '' } })
          if (current.status !== 200) return send(response, origin, current.status, current.json)
          if (current.json.revision > after) return send(response, origin, 200, current.json)
          if (Date.now() >= end || request.destroyed) return send(response, origin, 200, { revision: current.json.revision, changed: false })
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
      }

      return proxy(request, response)
    } catch (error) {
      return send(response, origin, 500, { error: String(error?.message ?? error), code: 'harness_error' })
    }
  })
  outer.listen(port, '127.0.0.1')
  await once(outer, 'listening')
  const baseUrl = `http://127.0.0.1:${outer.address().port}`

  return {
    baseUrl,
    store,
    stats,
    /** Records the account password so the harness can mint sessions (the real service owns its own credentials). */
    registerAccount(username, password) {
      accounts.set(username, { password })
    },
    /** Mints a one-time link (what `POST /v1/broker/links` + the desktop QR would produce). */
    async createLink({ username, hostId, hostLabel = 'Studio', syncUrl = baseUrl }) {
      const account = accounts.get(username)
      const salt = store.read().accounts[username].encryptionSalt
      const key = await deriveAccountKey(account.password, salt)
      const token = randomBytes(24).toString('base64url')
      links.set(hash(token), { username, hostId, expiresAt: Date.now() + LINK_LIFETIME_MS, usedAt: null })
      const payload = { v: 1, sync: syncUrl, token, username, key: Buffer.from(key).toString('base64url'), hostId, hostLabel }
      return { payload, fragment: Buffer.from(JSON.stringify(payload)).toString('base64url'), key }
    },
    async close() {
      outer.closeAllConnections?.()
      inner.closeAllConnections?.()
      await Promise.all([new Promise((resolve) => outer.close(resolve)), new Promise((resolve) => inner.close(resolve))])
    },
  }
}

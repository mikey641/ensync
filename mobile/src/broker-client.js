// Ensync Sync client for the phone. A QR link (see link.js) is the only way in:
// the claim returns a session, a long-lived refresh token, and a client device
// already paired with the desktop Host. The session refreshes itself, so the
// phone stays signed in without a password.

import {
  decryptBroker,
  decryptWorkspace,
  encryptBroker,
  encryptWorkspace,
  importAccountKey,
  requestHash,
} from './crypto.js'
import { normalizedServiceUrl } from './link.js'

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const REFRESH_MARGIN_MS = 2 * 60 * 1000
const SESSION_FAILURE_CODES = new Set(['login_required', 'session_expired', 'account_missing'])

export class SyncError extends Error {
  constructor(message, code, status = 0, details = null) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

function expiryMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now() + 60 * 60 * 1000
}

export function newDeviceId() {
  return `client_${crypto.randomUUID().replaceAll('-', '')}`
}

export function defaultDeviceLabel() {
  const agent = typeof navigator !== 'undefined' ? navigator.userAgent ?? '' : ''
  if (/iPhone/.test(agent)) return 'iPhone'
  if (/iPad/.test(agent)) return 'iPad'
  if (/Android/.test(agent)) return 'Android phone'
  return 'Phone'
}

async function readPayload(response) {
  const text = await response.text().catch(() => '')
  if (!text) return { json: {}, isJson: true }
  try { return { json: JSON.parse(text), isJson: true } } catch { return { json: {}, isJson: false } }
}

async function rawRequest(baseUrl, path, { method = 'GET', body, headers = {}, signal } = {}) {
  let response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new SyncError('Your computer could not be reached.', 'network_unreachable')
  }
  const { json, isJson } = await readPayload(response)
  if (!response.ok) {
    // A dead Cloudflare quick tunnel answers with an HTML error page (530/1033,
    // 502, 404) instead of an Ensync JSON error: the address is gone.
    if (!isJson || (!json.code && response.status >= 500)) {
      throw new SyncError('Your computer could not be reached.', 'network_unreachable', response.status)
    }
    throw new SyncError(json.error || `Ensync Sync failed (${response.status}).`, json.code || 'sync_request_failed', response.status, json)
  }
  return json
}

export class BrokerClient {
  /** Restores a client from the persisted link state (see `toJSON`). */
  static async restore(saved) {
    const client = new BrokerClient(saved)
    client.key = await importAccountKey(saved.key)
    return client
  }

  /**
   * Claims a one-time desktop link token. Returns a ready client; persist
   * `client.toJSON()` so the phone stays linked across reloads.
   */
  static async claimLink(link, { deviceId = newDeviceId(), label = defaultDeviceLabel() } = {}) {
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('A valid device ID is required.')
    const baseUrl = normalizedServiceUrl(link.sync)
    const key = await importAccountKey(link.key)
    const payload = await rawRequest(baseUrl, '/v1/broker/links/claim', {
      method: 'POST',
      body: { token: link.token, deviceId, label },
    })
    const deviceToken = payload.deviceToken ?? payload.device?.token ?? payload.token
    const sessionToken = payload.session?.token
    if (typeof sessionToken !== 'string' || typeof payload.refreshToken !== 'string' || typeof deviceToken !== 'string') {
      throw new SyncError('Ensync on your computer returned an incomplete phone link. Update Ensync and scan again.', 'sync_protocol_invalid')
    }
    const host = payload.host && typeof payload.host === 'object' ? payload.host : {}
    const client = new BrokerClient({
      baseUrl,
      username: typeof payload.username === 'string' && payload.username ? payload.username : link.username,
      key: link.key,
      deviceId: payload.device?.id ?? deviceId,
      deviceToken,
      session: { token: sessionToken, expiresAt: expiryMs(payload.session.expiresAt) },
      refreshToken: payload.refreshToken,
      host: { ...host, id: host.id ?? link.hostId, label: host.label ?? link.hostLabel },
      linkedAt: new Date().toISOString(),
    })
    client.key = key
    return client
  }

  constructor(saved) {
    this.baseUrl = normalizedServiceUrl(saved.baseUrl)
    this.username = saved.username
    this.rawKey = saved.key
    this.deviceId = saved.deviceId
    this.deviceToken = saved.deviceToken
    this.session = saved.session ? { token: saved.session.token, expiresAt: expiryMs(saved.session.expiresAt) } : null
    this.refreshToken = saved.refreshToken
    this.host = saved.host ?? null
    this.linkedAt = saved.linkedAt ?? null
    this.key = null
    this.onChange = null
    this.refreshing = null
  }

  toJSON() {
    return {
      baseUrl: this.baseUrl,
      username: this.username,
      key: this.rawKey,
      deviceId: this.deviceId,
      deviceToken: this.deviceToken,
      session: this.session,
      refreshToken: this.refreshToken,
      host: this.host,
      linkedAt: this.linkedAt,
    }
  }

  /** Exchanges the refresh token for a new session. Concurrent callers share one refresh. */
  async refreshSession() {
    this.refreshing ??= (async () => {
      await null
      try {
        const payload = await rawRequest(this.baseUrl, '/v1/sessions/refresh', {
          method: 'POST',
          body: { refreshToken: this.refreshToken, deviceId: this.deviceId },
        })
        if (typeof payload.session?.token !== 'string') {
          throw new SyncError('The session refresh response was invalid.', 'sync_protocol_invalid')
        }
        this.session = { token: payload.session.token, expiresAt: expiryMs(payload.session.expiresAt) }
        if (typeof payload.refreshToken === 'string') this.refreshToken = payload.refreshToken
        this.onChange?.(this)
      } catch (error) {
        // Only an explicit revocation unlinks the phone. Anything else (rate
        // limits, proxies, a restarting service) is temporary: keep the link and retry.
        if (error instanceof SyncError && error.status === 401 && ['refresh_invalid', 'device_revoked'].includes(error.code)) {
          throw new SyncError('This phone was disconnected from your computer. Scan the QR again.', 'link_revoked', error.status)
        }
        throw error
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  async request(path, options = {}) {
    if (!this.session || this.session.expiresAt - Date.now() < REFRESH_MARGIN_MS) await this.refreshSession()
    const send = () => rawRequest(this.baseUrl, path, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.session.token}`,
        'X-Ensync-Device-Id': this.deviceId,
        'X-Ensync-Device-Token': this.deviceToken,
        ...options.headers,
      },
    })
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof SyncError) || error.status !== 401 || !SESSION_FAILURE_CODES.has(error.code)) {
        if (error instanceof SyncError && error.code === 'broker_device_authentication_failed') {
          throw new SyncError('This phone was disconnected from your computer. Scan the QR again.', 'link_revoked', 401)
        }
        throw error
      }
      await this.refreshSession()
      return send()
    }
  }

  async hosts() {
    return (await this.request('/v1/broker/hosts')).hosts ?? []
  }

  #workspaceResult(payload) {
    const revision = Number.isSafeInteger(payload?.revision) && payload.revision >= 0 ? payload.revision : null
    if (revision === null) throw new SyncError('The sync revision is invalid.', 'sync_protocol_invalid')
    return payload
  }

  async #openWorkspace(payload) {
    const result = this.#workspaceResult(payload)
    const state = result.document ? await decryptWorkspace(result.document, this.key, this.username) : null
    return { revision: result.revision, state, updatedAt: result.updatedAt ?? null, changed: true }
  }

  async getWorkspace() {
    return this.#openWorkspace(await this.request('/v1/workspace'))
  }

  /**
   * Long-polls for a revision newer than `after`. Resolves `{ changed: false }`
   * on timeout. Throws a SyncError with status 404 when the service predates
   * the endpoint so callers can fall back to interval polling.
   */
  async waitWorkspace(after, { timeout = 25, signal } = {}) {
    const payload = await this.request(`/v1/workspace/wait?after=${encodeURIComponent(after)}&timeout=${timeout}`, { signal })
    if (payload.changed === false || !('document' in payload)) {
      return { revision: this.#workspaceResult(payload).revision, changed: false }
    }
    return this.#openWorkspace(payload)
  }

  async putWorkspace(state, baseRevision) {
    const document = await encryptWorkspace(state, this.key, this.username)
    try {
      const payload = await this.request('/v1/workspace', { method: 'PUT', body: { baseRevision, document } })
      return { status: 'saved', revision: this.#workspaceResult(payload).revision }
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== 'sync_revision_conflict' || !error.details) throw error
      const remote = await this.#openWorkspace(error.details)
      return { status: 'conflict', revision: remote.revision, state: remote.state }
    }
  }

  /**
   * Builds the encrypted broker job. `request` follows the phone-sync spec:
   * provider, projectPath, prompt, workspaceKey, optional sessionId/model,
   * conversationId and messageId. Pass a stable `jobId` to make retries idempotent.
   */
  async submit({ hostId, jobId = `job_${crypto.randomUUID()}`, request }) {
    const clear = { version: 1, kind: 'local', request: compactRequest(request) }
    const hash = await requestHash(clear)
    const envelope = await encryptBroker(clear, this.key, {
      username: this.username, hostId, clientId: this.deviceId, jobId, kind: 'run', messageId: jobId,
    })
    return (await this.request('/v1/broker/jobs', {
      method: 'POST',
      body: { hostId, jobId, requestHash: hash, envelope },
    })).job
  }

  async job(jobId, after = 0) {
    const job = (await this.request(`/v1/broker/jobs/${encodeURIComponent(jobId)}?after=${after}`)).job
    const events = []
    for (const item of job.events ?? []) {
      const clear = await decryptBroker(item.envelope, this.key, {
        username: this.username,
        hostId: job.hostId,
        clientId: job.clientId,
        jobId: job.id,
        kind: 'event',
        messageId: String(item.sequence),
      })
      if (clear?.event?.sequence !== item.sequence) throw new Error('A remote event sequence could not be authenticated.')
      events.push(clear.event)
    }
    return { ...job, events }
  }

  async command(job, type, payload = {}) {
    const commandId = `cmd_${crypto.randomUUID()}`
    const clear = { version: 1, type, payload }
    const envelope = await encryptBroker(clear, this.key, {
      username: this.username,
      hostId: job.hostId,
      clientId: job.clientId ?? this.deviceId,
      jobId: job.id,
      kind: `command:${type}`,
      messageId: commandId,
    })
    return (await this.request(`/v1/broker/jobs/${encodeURIComponent(job.id)}/commands`, {
      method: 'POST',
      body: { commandId, type, requestHash: await requestHash(clear), envelope },
    })).command
  }
}

function compactRequest(request) {
  const result = {}
  for (const key of ['provider', 'projectPath', 'prompt', 'workspaceKey', 'sessionId', 'model', 'conversationId', 'messageId']) {
    const value = request?.[key]
    if (typeof value === 'string' && value) result[key] = value
  }
  return result
}

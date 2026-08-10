import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const MAX_REMOTE_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024

export class AccountSyncError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message)
    this.name = 'AccountSyncError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function loopbackHostname(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase())
}

export function normalizeAccountSyncServiceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new AccountSyncError('sync_configuration_invalid', 'ENSYNC_SYNC_SERVICE_URL must be an absolute HTTPS URL.', 500)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AccountSyncError('sync_configuration_invalid', 'The sync service URL cannot contain credentials, query parameters, or a fragment.', 500)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHostname(url.hostname))) {
    throw new AccountSyncError('sync_configuration_invalid', 'The sync service must use HTTPS unless it is running on this computer.', 500)
  }
  return url.href.replace(/\/$/, '')
}

function validDocument(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.version === 1
    && value.algorithm === 'aes-256-gcm'
    && typeof value.iv === 'string'
    && typeof value.ciphertext === 'string'
    && typeof value.tag === 'string',
  )
}

async function readBoundedResponse(response, controller) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_REMOTE_RESPONSE_BYTES) {
      controller.abort()
      await reader.cancel().catch(() => {})
      throw new AccountSyncError('sync_response_too_large', 'The account sync service returned too much data.', 502)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function deriveEncryptionKey(password, salt) {
  let decodedSalt
  try {
    decodedSalt = Buffer.from(salt, 'base64url')
  } catch {
    decodedSalt = Buffer.alloc(0)
  }
  if (decodedSalt.length < 16 || decodedSalt.length > 64) {
    throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid encryption salt.', 502)
  }
  return scrypt(password, decodedSalt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

function encryptWorkspace(state, key, username) {
  const plaintext = Buffer.from(JSON.stringify(state), 'utf8')
  if (plaintext.length > MAX_WORKSPACE_BYTES) {
    throw new AccountSyncError('sync_workspace_too_large', 'The synchronized conversation history is too large for one account document.', 413)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`ensync-account-workspace-v1\n${username}`, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
}

function decryptWorkspace(document, key, username) {
  if (!validDocument(document)) {
    throw new AccountSyncError('sync_document_invalid', 'The remote conversation document is invalid.', 502)
  }
  try {
    const iv = Buffer.from(document.iv, 'base64url')
    const ciphertext = Buffer.from(document.ciphertext, 'base64url')
    const tag = Buffer.from(document.tag, 'base64url')
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_WORKSPACE_BYTES + 1024) {
      throw new Error('invalid encrypted document sizes')
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(`ensync-account-workspace-v1\n${username}`, 'utf8'))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const state = JSON.parse(plaintext.toString('utf8'))
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid workspace payload')
    return state
  } catch (error) {
    if (error instanceof AccountSyncError) throw error
    throw new AccountSyncError(
      'sync_decryption_failed',
      'This computer could not decrypt the synchronized conversations. Check the account password and remote data.',
      409,
    )
  }
}

export class AccountSyncService {
  #baseUrl
  #fetch
  #session = null
  #lastSyncedAt = null
  #remoteRevision = 0

  constructor(options = {}) {
    this.#baseUrl = normalizeAccountSyncServiceUrl(options.baseUrl ?? null)
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  status() {
    return {
      configured: Boolean(this.#baseUrl),
      authenticated: Boolean(this.#session),
      username: this.#session?.username ?? null,
      remoteRevision: this.#session ? this.#remoteRevision : null,
      lastSyncedAt: this.#lastSyncedAt,
      encryption: 'aes-256-gcm',
      credentialStorage: 'host_memory_only',
    }
  }

  async #request(path, options = {}) {
    if (!this.#baseUrl) {
      throw new AccountSyncError(
        'sync_not_configured',
        'Account sync is not configured for this Ensync build.',
        503,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...options,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.#session ? { Authorization: `Bearer ${this.#session.token}` } : {}),
          ...options.headers,
        },
      })
    } catch (error) {
      clearTimeout(timer)
      const message = error?.name === 'AbortError'
        ? 'The account sync service timed out.'
        : 'The account sync service could not be reached.'
      throw new AccountSyncError('sync_service_unavailable', message, 503)
    }

    let body
    try {
      body = await readBoundedResponse(response, controller)
    } catch (error) {
      if (error instanceof AccountSyncError) throw error
      const message = error?.name === 'AbortError'
        ? 'The account sync service timed out.'
        : 'The account sync service response could not be read.'
      throw new AccountSyncError('sync_service_unavailable', message, 503)
    } finally {
      clearTimeout(timer)
    }
    let payload
    try {
      payload = body ? JSON.parse(body) : {}
    } catch {
      throw new AccountSyncError('sync_protocol_invalid', 'The account sync service returned invalid JSON.', 502)
    }
    if (!response.ok) {
      throw new AccountSyncError(
        typeof payload.code === 'string' ? payload.code : 'sync_request_failed',
        typeof payload.error === 'string' ? payload.error : `Account sync failed (${response.status}).`,
        response.status,
        payload,
      )
    }
    return payload
  }

  async #authenticate(path, credentials) {
    const payload = await this.#request(path, {
      method: 'POST',
      body: JSON.stringify(credentials),
    })
    if (typeof payload.username !== 'string' || typeof payload.token !== 'string' || typeof payload.encryptionSalt !== 'string') {
      throw new AccountSyncError('sync_protocol_invalid', 'The account sync service returned an invalid login response.', 502)
    }
    const key = await deriveEncryptionKey(credentials.password, payload.encryptionSalt)
    this.#session = { username: payload.username, token: payload.token, key }
    this.#remoteRevision = 0
    this.#lastSyncedAt = null
    return this.status()
  }

  register(credentials) {
    return this.#authenticate('/v1/accounts', credentials)
  }

  login(credentials) {
    return this.#authenticate('/v1/sessions', credentials)
  }

  async logout() {
    const hadSession = Boolean(this.#session)
    try {
      if (hadSession) await this.#request('/v1/session', { method: 'DELETE' })
    } finally {
      this.#session = null
      this.#remoteRevision = 0
      this.#lastSyncedAt = null
    }
    return this.status()
  }

  #requireSession() {
    if (!this.#session) throw new AccountSyncError('sync_login_required', 'Sign in to synchronize conversations.', 401)
    return this.#session
  }

  async pull() {
    const session = this.#requireSession()
    const payload = await this.#request('/v1/workspace')
    const revision = Number.isSafeInteger(payload.revision) && payload.revision >= 0 ? payload.revision : null
    if (revision === null) throw new AccountSyncError('sync_protocol_invalid', 'The sync revision is invalid.', 502)
    const state = payload.document === null ? null : decryptWorkspace(payload.document, session.key, session.username)
    this.#remoteRevision = revision
    this.#lastSyncedAt = new Date().toISOString()
    return { state, revision, updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null }
  }

  async push(state, baseRevision) {
    const session = this.#requireSession()
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      throw new AccountSyncError('sync_revision_invalid', 'A valid remote sync revision is required.', 400)
    }
    const document = encryptWorkspace(state, session.key, session.username)
    try {
      const payload = await this.#request('/v1/workspace', {
        method: 'PUT',
        body: JSON.stringify({ baseRevision, document }),
      })
      this.#remoteRevision = payload.revision
      this.#lastSyncedAt = new Date().toISOString()
      return { status: 'saved', revision: payload.revision, updatedAt: payload.updatedAt }
    } catch (error) {
      if (!(error instanceof AccountSyncError) || error.code !== 'sync_revision_conflict') throw error
      const payload = error.details
      if (!payload || !Number.isSafeInteger(payload.revision) || !validDocument(payload.document)) throw error
      const remoteState = decryptWorkspace(payload.document, session.key, session.username)
      this.#remoteRevision = payload.revision
      return {
        status: 'conflict',
        revision: payload.revision,
        updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
        remoteState,
      }
    }
  }
}

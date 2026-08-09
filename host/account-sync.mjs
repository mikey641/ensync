import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const MAX_REMOTE_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024
const MAX_BROKER_PAYLOAD_BYTES = 1024 * 1024
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/

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

function brokerContext({ username, hostId, clientId, jobId, kind, messageId }) {
  const values = [username, hostId, clientId, jobId, kind, String(messageId)]
  if (values.some((value) => typeof value !== 'string' || !value || value.includes('\n'))) {
    throw new AccountSyncError('sync_broker_context_invalid', 'The encrypted broker message context is invalid.', 400)
  }
  return Buffer.from(['ensync-broker-v1', ...values].join('\n'), 'utf8')
}

function encryptBrokerPayload(payload, key, context) {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  if (plaintext.length > MAX_BROKER_PAYLOAD_BYTES) {
    throw new AccountSyncError('sync_broker_payload_too_large', 'The encrypted remote job payload is too large.', 413)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(brokerContext(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
}

function decryptBrokerPayload(document, key, context) {
  if (!validDocument(document)) {
    throw new AccountSyncError('sync_broker_payload_invalid', 'The encrypted broker payload is invalid.', 502)
  }
  try {
    const iv = Buffer.from(document.iv, 'base64url')
    const ciphertext = Buffer.from(document.ciphertext, 'base64url')
    const tag = Buffer.from(document.tag, 'base64url')
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_BROKER_PAYLOAD_BYTES + 1024) {
      throw new Error('invalid encrypted broker payload sizes')
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(brokerContext(context))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const payload = JSON.parse(plaintext.toString('utf8'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid broker payload')
    return payload
  } catch (error) {
    if (error instanceof AccountSyncError) throw error
    throw new AccountSyncError(
      'sync_broker_decryption_failed',
      'This device could not authenticate the encrypted remote execution payload.',
      409,
    )
  }
}

function brokerRequestHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function brokerCommandId() {
  return `cmd_${randomBytes(18).toString('base64url')}`
}

function assertBrokerDevice(device, role = null) {
  if (!device || (role && device.role !== role)) {
    throw new AccountSyncError(
      'sync_broker_device_required',
      role ? `Register this Ensync device as a broker ${role} first.` : 'Register this Ensync broker device first.',
      409,
    )
  }
  return device
}

function validBrokerJobId(value) {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    throw new AccountSyncError('sync_broker_job_invalid', 'A valid remote job ID is required.', 400)
  }
  return value
}

export class AccountSyncService {
  #baseUrl
  #fetch
  #session = null
  #brokerDevice = null
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
      brokerDevice: this.#brokerDevice ? {
        id: this.#brokerDevice.id,
        role: this.#brokerDevice.role,
        label: this.#brokerDevice.label,
        registeredAt: this.#brokerDevice.registeredAt,
        lastSeenAt: this.#brokerDevice.lastSeenAt ?? null,
      } : null,
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
          ...(this.#brokerDevice ? {
            'X-Ensync-Device-Id': this.#brokerDevice.id,
            'X-Ensync-Device-Token': this.#brokerDevice.token,
          } : {}),
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
    this.#brokerDevice = null
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
      this.#brokerDevice = null
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

  async registerBrokerDevice(input) {
    this.#requireSession()
    const deviceId = typeof input?.deviceId === 'string' ? input.deviceId : ''
    const role = input?.role === 'host' || input?.role === 'client' ? input.role : null
    const label = typeof input?.label === 'string' ? input.label.trim() : ''
    if (!DEVICE_ID_PATTERN.test(deviceId) || !role || !label || label.length > 120) {
      throw new AccountSyncError('sync_broker_device_invalid', 'A valid device ID, role, and name are required.', 400)
    }
    const payload = await this.#request('/v1/broker/devices', {
      method: 'POST',
      body: JSON.stringify({ deviceId, role, label }),
    })
    if (!payload?.device || payload.device.id !== deviceId || payload.device.role !== role
      || typeof payload.token !== 'string' || payload.token.length < 32) {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid broker device registration.', 502)
    }
    this.#brokerDevice = { ...payload.device, token: payload.token }
    return this.status().brokerDevice
  }

  async revokeBrokerDevice() {
    assertBrokerDevice(this.#brokerDevice)
    try {
      return await this.#request('/v1/broker/devices/revoke', { method: 'POST' })
    } finally {
      this.#brokerDevice = null
    }
  }

  async createBrokerPairing() {
    assertBrokerDevice(this.#brokerDevice, 'host')
    const payload = await this.#request('/v1/broker/pairings', { method: 'POST', body: '{}' })
    if (!payload?.pairing || typeof payload.code !== 'string') {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid broker pairing.', 502)
    }
    return payload
  }

  async claimBrokerPairing(code) {
    assertBrokerDevice(this.#brokerDevice, 'client')
    const payload = await this.#request('/v1/broker/pairings/claim', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
    if (!payload?.pairing?.host?.id) {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid claimed pairing.', 502)
    }
    return payload.pairing
  }

  async listBrokerHosts() {
    assertBrokerDevice(this.#brokerDevice, 'client')
    const payload = await this.#request('/v1/broker/hosts')
    if (!Array.isArray(payload.hosts)) {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid Host list.', 502)
    }
    return payload.hosts
  }

  async revokeBrokerPairing(pairingId) {
    assertBrokerDevice(this.#brokerDevice)
    return this.#request('/v1/broker/pairings/revoke', {
      method: 'POST',
      body: JSON.stringify({ pairingId }),
    })
  }

  async submitBrokerJob(input) {
    const session = this.#requireSession()
    const device = assertBrokerDevice(this.#brokerDevice, 'client')
    const jobId = validBrokerJobId(input?.jobId)
    const hostId = typeof input?.hostId === 'string' && DEVICE_ID_PATTERN.test(input.hostId) ? input.hostId : null
    const kind = input?.kind === 'local' || input?.kind === 'ssh' ? input.kind : null
    if (!hostId || !kind || !input.request || typeof input.request !== 'object' || Array.isArray(input.request)) {
      throw new AccountSyncError('sync_broker_job_invalid', 'A paired Host, execution kind, and job request are required.', 400)
    }
    const clearPayload = { version: 1, kind, request: input.request }
    const requestHash = brokerRequestHash(clearPayload)
    const envelope = encryptBrokerPayload(clearPayload, session.key, {
      username: session.username,
      hostId,
      clientId: device.id,
      jobId,
      kind: 'run',
      messageId: jobId,
    })
    const payload = await this.#request('/v1/broker/jobs', {
      method: 'POST',
      body: JSON.stringify({ hostId, jobId, requestHash, envelope }),
    })
    if (!payload?.job || payload.job.id !== jobId || payload.job.requestHash !== requestHash) {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid remote job.', 502)
    }
    return payload.job
  }

  #decryptBrokerJob(job, session = this.#requireSession()) {
    const device = assertBrokerDevice(this.#brokerDevice, 'host')
    if (!job || job.hostId !== device.id || typeof job.clientId !== 'string' || !validDocument(job.envelope)) {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid queued broker job.', 502)
    }
    const clearPayload = decryptBrokerPayload(job.envelope, session.key, {
      username: session.username,
      hostId: job.hostId,
      clientId: job.clientId,
      jobId: job.id,
      kind: 'run',
      messageId: job.id,
    })
    if (clearPayload.version !== 1 || !['local', 'ssh'].includes(clearPayload.kind)
      || !clearPayload.request || typeof clearPayload.request !== 'object' || Array.isArray(clearPayload.request)
      || brokerRequestHash(clearPayload) !== job.requestHash) {
      throw new AccountSyncError('sync_broker_payload_invalid', 'The queued broker job did not match its authenticated request hash.', 409)
    }
    return { ...job, kind: clearPayload.kind, request: clearPayload.request }
  }

  async pollBrokerHostJobs() {
    const session = this.#requireSession()
    const device = assertBrokerDevice(this.#brokerDevice, 'host')
    const payload = await this.#request(`/v1/broker/hosts/${encodeURIComponent(device.id)}/jobs`)
    if (!Array.isArray(payload.jobs)) {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid remote job queue.', 502)
    }
    return payload.jobs.map((job) => this.#decryptBrokerJob(job, session))
  }

  async claimBrokerJob(job) {
    validBrokerJobId(job?.id)
    assertBrokerDevice(this.#brokerDevice, 'host')
    const payload = await this.#request(`/v1/broker/jobs/${encodeURIComponent(job.id)}/claim`, {
      method: 'POST',
      body: '{}',
    })
    if (!payload?.job || payload.job.id !== job.id || typeof payload.newlyClaimed !== 'boolean') {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid claimed remote job.', 502)
    }
    return { ...job, state: payload.job.state, claimedAt: payload.job.claimedAt, newlyClaimed: payload.newlyClaimed }
  }

  async publishBrokerEvent(job, event) {
    const session = this.#requireSession()
    const device = assertBrokerDevice(this.#brokerDevice, 'host')
    validBrokerJobId(job?.id)
    if (job.hostId !== device.id || typeof job.clientId !== 'string'
      || !event || typeof event !== 'object' || !Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      throw new AccountSyncError('sync_broker_event_invalid', 'A valid broker job event is required.', 400)
    }
    const state = event.type === 'completed'
      ? 'completed'
      : event.type === 'cancelled'
        ? 'cancelled'
        : event.type === 'error'
          ? ['host_job_orphaned', 'broker_job_reconciliation_required'].includes(event.code)
            ? 'reconciliation_required'
            : 'failed'
          : 'running'
    const envelope = encryptBrokerPayload({ version: 1, event }, session.key, {
      username: session.username,
      hostId: job.hostId,
      clientId: job.clientId,
      jobId: job.id,
      kind: 'event',
      messageId: String(event.sequence),
    })
    const payload = await this.#request(`/v1/broker/jobs/${encodeURIComponent(job.id)}/events`, {
      method: 'POST',
      body: JSON.stringify({ sequence: event.sequence, state, envelope }),
    })
    return payload.job
  }

  async brokerJob(jobId, afterSequence = 0) {
    const session = this.#requireSession()
    const device = assertBrokerDevice(this.#brokerDevice)
    validBrokerJobId(jobId)
    const after = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0
    const payload = await this.#request(`/v1/broker/jobs/${encodeURIComponent(jobId)}?after=${after}`)
    const job = payload?.job
    if (!job || job.id !== jobId || typeof job.hostId !== 'string' || typeof job.clientId !== 'string'
      || (device.id !== job.hostId && device.id !== job.clientId) || !Array.isArray(job.events)) {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid remote job status.', 502)
    }
    return {
      ...job,
      events: job.events.map((item) => {
        const clear = decryptBrokerPayload(item.envelope, session.key, {
          username: session.username,
          hostId: job.hostId,
          clientId: job.clientId,
          jobId: job.id,
          kind: 'event',
          messageId: String(item.sequence),
        })
        if (clear.version !== 1 || !clear.event || clear.event.sequence !== item.sequence) {
          throw new AccountSyncError('sync_broker_payload_invalid', 'A remote job event failed authenticated sequence validation.', 409)
        }
        return { ...item, event: clear.event, envelope: undefined, envelopeHash: undefined }
      }),
      commands: Array.isArray(job.commands) ? job.commands.map((command) => {
        if (!command.ackEnvelope) return { ...command, envelope: undefined }
        const clear = decryptBrokerPayload(command.ackEnvelope, session.key, {
          username: session.username,
          hostId: job.hostId,
          clientId: job.clientId,
          jobId: job.id,
          kind: `command-ack:${command.type}`,
          messageId: command.id,
        })
        return { ...command, envelope: undefined, ackEnvelope: undefined, acknowledgement: clear }
      }) : [],
    }
  }

  async sendBrokerCommand(job, type, commandPayload = {}) {
    const session = this.#requireSession()
    const device = assertBrokerDevice(this.#brokerDevice, 'client')
    validBrokerJobId(job?.id)
    if (job.clientId !== device.id || typeof job.hostId !== 'string' || !['cancel', 'steer'].includes(type)) {
      throw new AccountSyncError('sync_broker_command_invalid', 'A valid paired remote job command is required.', 400)
    }
    const commandId = brokerCommandId()
    const clearPayload = { version: 1, type, payload: commandPayload }
    const requestHash = brokerRequestHash(clearPayload)
    const envelope = encryptBrokerPayload(clearPayload, session.key, {
      username: session.username,
      hostId: job.hostId,
      clientId: job.clientId,
      jobId: job.id,
      kind: `command:${type}`,
      messageId: commandId,
    })
    const response = await this.#request(`/v1/broker/jobs/${encodeURIComponent(job.id)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ commandId, type, requestHash, envelope }),
    })
    return response.command
  }

  async pollBrokerCommands(job, afterSequence = 0) {
    const session = this.#requireSession()
    const device = assertBrokerDevice(this.#brokerDevice, 'host')
    validBrokerJobId(job?.id)
    if (job.hostId !== device.id || typeof job.clientId !== 'string') {
      throw new AccountSyncError('sync_broker_command_invalid', 'The remote job is not assigned to this Host.', 403)
    }
    const after = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0
    const response = await this.#request(`/v1/broker/jobs/${encodeURIComponent(job.id)}/commands?after=${after}`)
    if (!Array.isArray(response.commands)) {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned invalid remote job commands.', 502)
    }
    return response.commands.map((command) => {
      const clear = decryptBrokerPayload(command.envelope, session.key, {
        username: session.username,
        hostId: job.hostId,
        clientId: job.clientId,
        jobId: job.id,
        kind: `command:${command.type}`,
        messageId: command.id,
      })
      if (clear.version !== 1 || clear.type !== command.type || brokerRequestHash(clear) !== command.requestHash) {
        throw new AccountSyncError('sync_broker_payload_invalid', 'A remote job command failed authenticated request validation.', 409)
      }
      return { ...command, payload: clear.payload, envelope: undefined }
    })
  }

  async acknowledgeBrokerCommand(job, command, acknowledgement) {
    const session = this.#requireSession()
    const device = assertBrokerDevice(this.#brokerDevice, 'host')
    if (job?.hostId !== device.id || typeof job.clientId !== 'string' || typeof command?.id !== 'string') {
      throw new AccountSyncError('sync_broker_command_invalid', 'A valid broker command acknowledgement is required.', 400)
    }
    const envelope = encryptBrokerPayload({ version: 1, acknowledgement }, session.key, {
      username: session.username,
      hostId: job.hostId,
      clientId: job.clientId,
      jobId: job.id,
      kind: `command-ack:${command.type}`,
      messageId: command.id,
    })
    const response = await this.#request(
      `/v1/broker/jobs/${encodeURIComponent(job.id)}/commands/${encodeURIComponent(command.id)}/ack`,
      { method: 'POST', body: JSON.stringify({ envelope }) },
    )
    return response.command
  }

  async claimBrokerCommand(job, command) {
    const device = assertBrokerDevice(this.#brokerDevice, 'host')
    if (job?.hostId !== device.id || typeof command?.id !== 'string') {
      throw new AccountSyncError('sync_broker_command_invalid', 'A valid broker command claim is required.', 400)
    }
    const response = await this.#request(
      `/v1/broker/jobs/${encodeURIComponent(job.id)}/commands/${encodeURIComponent(command.id)}/claim`,
      { method: 'POST', body: '{}' },
    )
    if (!response?.command || response.command.id !== command.id || typeof response.newlyClaimed !== 'boolean') {
      throw new AccountSyncError('sync_protocol_invalid', 'The sync service returned an invalid broker command claim.', 502)
    }
    return response
  }
}

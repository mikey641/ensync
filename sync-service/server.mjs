import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,31}$/
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const MAX_REQUEST_BYTES = 12 * 1024 * 1024
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000
const PAIRING_LIFETIME_MS = 10 * 60 * 1000
const MAX_BROKER_CIPHERTEXT_CHARACTERS = 2 * 1024 * 1024
const MAX_BROKER_JOBS = 256
const MAX_BROKER_EVENTS_PER_JOB = 2_000
const MAX_BROKER_COMMANDS_PER_JOB = 256
const TERMINAL_BROKER_STATES = new Set(['completed', 'failed', 'cancelled', 'reconciliation_required'])
const BROKER_STATES = new Set(['queued', 'claimed', 'running', ...TERMINAL_BROKER_STATES])
const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

class SyncServiceError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

function normalizedUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!USERNAME_PATTERN.test(username)) {
    throw new SyncServiceError('username_invalid', 'Use 3–32 lowercase letters, numbers, dots, dashes, or underscores.', 400)
  }
  return username
}

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
    throw new SyncServiceError('password_invalid', 'Use a password between 12 and 256 characters.', 400)
  }
  return value
}

function validDocument(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.version === 1
    && value.algorithm === 'aes-256-gcm'
    && typeof value.iv === 'string' && value.iv.length <= 64
    && typeof value.tag === 'string' && value.tag.length <= 64
    && typeof value.ciphertext === 'string' && value.ciphertext.length <= 11 * 1024 * 1024,
  )
}

function validBrokerEnvelope(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.version === 1
    && value.algorithm === 'aes-256-gcm'
    && typeof value.iv === 'string' && value.iv.length <= 64
    && typeof value.tag === 'string' && value.tag.length <= 64
    && typeof value.ciphertext === 'string'
    && value.ciphertext.length <= MAX_BROKER_CIPHERTEXT_CHARACTERS,
  )
}

function validIdentifier(value, pattern, message) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new SyncServiceError('broker_identifier_invalid', message, 400)
  }
  return value
}

function normalizedDeviceLabel(value) {
  const label = typeof value === 'string' ? value.trim() : ''
  if (!label || label.length > 120) {
    throw new SyncServiceError('broker_device_invalid', 'Use a device name between 1 and 120 characters.', 400)
  }
  return label
}

function hashSecret(value) {
  return createHash('sha256').update(value).digest('base64url')
}

function secretMatches(value, expectedHash) {
  if (typeof value !== 'string' || typeof expectedHash !== 'string') return false
  const actual = Buffer.from(hashSecret(value), 'utf8')
  const expected = Buffer.from(expectedHash, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function pairingCode() {
  const bytes = randomBytes(8)
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join('')
}

function emptyBroker() {
  return { version: 1, devices: {}, pairings: {}, jobs: {} }
}

function brokerFor(account) {
  if (!account.broker || account.broker.version !== 1) account.broker = emptyBroker()
  account.broker.devices ??= {}
  account.broker.pairings ??= {}
  account.broker.jobs ??= {}
  return account.broker
}

function activePairing(broker, hostId, clientId) {
  return Object.values(broker.pairings).find((pairing) => pairing
    && pairing.hostId === hostId
    && pairing.clientId === clientId
    && typeof pairing.claimedAt === 'string'
    && !pairing.revokedAt) ?? null
}

function publicDevice(device) {
  return {
    id: device.id,
    role: device.role,
    label: device.label,
    registeredAt: device.registeredAt,
    lastSeenAt: device.lastSeenAt ?? null,
  }
}

function publicPairing(pairing, broker) {
  const host = broker.devices[pairing.hostId]
  const client = pairing.clientId ? broker.devices[pairing.clientId] : null
  return {
    id: pairing.id,
    host: host ? publicDevice(host) : { id: pairing.hostId, role: 'host', label: 'Unavailable Host', registeredAt: null, lastSeenAt: null },
    client: client ? publicDevice(client) : null,
    createdAt: pairing.createdAt,
    expiresAt: pairing.expiresAt,
    claimedAt: pairing.claimedAt ?? null,
    revokedAt: pairing.revokedAt ?? null,
  }
}

function publicBrokerJob(job, options = {}) {
  const after = Number.isSafeInteger(options.after) && options.after >= 0 ? options.after : 0
  return {
    id: job.id,
    hostId: job.hostId,
    clientId: job.clientId,
    requestHash: job.requestHash,
    state: job.state,
    createdAt: job.createdAt,
    claimedAt: job.claimedAt ?? null,
    terminalAt: job.terminalAt ?? null,
    lastEventSequence: job.lastEventSequence ?? 0,
    events: (job.events ?? []).filter((event) => event.sequence > after).map((event) => ({ ...event })),
    commands: (job.commands ?? []).map((command) => ({ ...command })),
  }
}

function trimBrokerJobs(broker) {
  const jobs = Object.values(broker.jobs)
  if (jobs.length < MAX_BROKER_JOBS) return
  const removable = jobs
    .filter((job) => TERMINAL_BROKER_STATES.has(job.state))
    .sort((left, right) => String(left.terminalAt).localeCompare(String(right.terminalAt)))
  while (Object.keys(broker.jobs).length >= MAX_BROKER_JOBS && removable.length) {
    delete broker.jobs[removable.shift().id]
  }
  if (Object.keys(broker.jobs).length >= MAX_BROKER_JOBS) {
    throw new SyncServiceError('broker_capacity', 'This account has too many retained remote jobs.', 503)
  }
}

async function passwordHash(password, salt) {
  return (await scrypt(password, Buffer.from(salt, 'base64url'), 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })).toString('base64url')
}

function emptyData() {
  return { version: 1, accounts: {} }
}

export class MemorySyncStore {
  constructor(initial = emptyData()) {
    this.data = structuredClone(initial)
  }

  read() {
    return structuredClone(this.data)
  }

  write(data) {
    this.data = structuredClone(data)
  }
}

export class FileSyncStore {
  constructor(filePath) {
    this.filePath = resolve(filePath)
  }

  read() {
    try {
      const value = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return value?.version === 1 && value.accounts && typeof value.accounts === 'object'
        ? value
        : emptyData()
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyData()
      throw error
    }
  }

  write(data) {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const staging = `${this.filePath}.staging`
    writeFileSync(staging, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
    chmodSync(staging, 0o600)
    renameSync(staging, this.filePath)
  }
}

function json(response, status, payload) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

function body(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new SyncServiceError('request_too_large', 'The sync request is too large.', 413))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new SyncServiceError('invalid_json', 'The request body must be valid JSON.', 400))
      }
    })
    request.on('error', reject)
  })
}

function sessionKey(token) {
  return createHash('sha256').update(token).digest('base64url')
}

function configuredOrigins(value) {
  return new Set((typeof value === 'string' ? value : '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean))
}

function browserOriginAllowed(origin, configured) {
  if (!origin) return true
  if (configured.has(origin)) return true
  try {
    const url = new URL(origin)
    if (url.protocol === 'capacitor:' && url.hostname === 'localhost') return true
    return ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function createEnsyncSyncServer(options = {}) {
  const store = options.store ?? new MemorySyncStore()
  const sessions = new Map()
  const allowedOrigins = configuredOrigins(options.allowedOrigins ?? process.env.ENSYNC_SYNC_ALLOWED_ORIGINS)

  function createSession(username) {
    const token = randomBytes(32).toString('base64url')
    sessions.set(sessionKey(token), { username, expiresAt: Date.now() + SESSION_LIFETIME_MS })
    return token
  }

  function authenticate(request) {
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new SyncServiceError('login_required', 'Sign in to synchronize conversations.', 401)
    }
    const key = sessionKey(header.slice(7))
    const session = sessions.get(key)
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(key)
      throw new SyncServiceError('session_expired', 'The account session expired. Sign in again.', 401)
    }
    return { key, ...session }
  }

  function authenticateDevice(request, session, data, expectedRole = null, expectedId = null) {
    const account = data.accounts[session.username]
    if (!account) throw new SyncServiceError('account_missing', 'The account no longer exists.', 401)
    const broker = brokerFor(account)
    const deviceId = request.headers['x-ensync-device-id']
    const token = request.headers['x-ensync-device-token']
    const device = typeof deviceId === 'string' ? broker.devices[deviceId] : null
    if (!device || device.revokedAt || !secretMatches(token, device.tokenHash)) {
      throw new SyncServiceError('broker_device_authentication_failed', 'The broker device is not registered or its token is invalid.', 401)
    }
    if (expectedRole && device.role !== expectedRole) {
      throw new SyncServiceError('broker_device_role_invalid', `This operation requires a ${expectedRole} device.`, 403)
    }
    if (expectedId && device.id !== expectedId) {
      throw new SyncServiceError('broker_target_invalid', 'The authenticated device does not own that broker target.', 403)
    }
    return { account, broker, device }
  }

  function brokerJobForDevice(broker, device, jobId) {
    const job = broker.jobs[jobId]
    if (!job) throw new SyncServiceError('broker_job_not_found', 'That remote job is not available.', 404)
    if (device.id !== job.hostId && device.id !== job.clientId) {
      throw new SyncServiceError('broker_job_forbidden', 'That remote job is not paired with this device.', 403)
    }
    return job
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const origin = request.headers.origin
    if (!browserOriginAllowed(origin, allowedOrigins)) {
      return json(response, 403, { error: 'Origin is not allowed.', code: 'origin_not_allowed' })
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Ensync-Device-Id, X-Ensync-Device-Token',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
      })
      return response.end()
    }
    try {
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        return json(response, 200, { service: 'ensync-sync', version: 1 })
      }

      if (request.method === 'POST' && url.pathname === '/v1/accounts') {
        const input = await body(request)
        const username = normalizedUsername(input.username)
        const password = validPassword(input.password)
        const data = store.read()
        if (data.accounts[username]) throw new SyncServiceError('username_taken', 'That username is already registered.', 409)
        const passwordSalt = randomBytes(16).toString('base64url')
        const encryptionSalt = randomBytes(16).toString('base64url')
        data.accounts[username] = {
          passwordSalt,
          passwordHash: await passwordHash(password, passwordSalt),
          encryptionSalt,
          createdAt: new Date().toISOString(),
          workspace: null,
        }
        store.write(data)
        return json(response, 201, { username, token: createSession(username), encryptionSalt })
      }

      if (request.method === 'POST' && url.pathname === '/v1/sessions') {
        const input = await body(request)
        const username = normalizedUsername(input.username)
        const password = validPassword(input.password)
        const account = store.read().accounts[username]
        const supplied = await passwordHash(
          password,
          account?.passwordSalt ?? randomBytes(16).toString('base64url'),
        )
        const expected = account?.passwordHash ?? randomBytes(32).toString('base64url')
        const valid = Boolean(account) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
        if (!valid) throw new SyncServiceError('login_failed', 'The username or password is incorrect.', 401)
        return json(response, 200, { username, token: createSession(username), encryptionSalt: account.encryptionSalt })
      }

      if (request.method === 'DELETE' && url.pathname === '/v1/session') {
        const session = authenticate(request)
        sessions.delete(session.key)
        return json(response, 200, { authenticated: false })
      }

      if (request.method === 'POST' && url.pathname === '/v1/broker/devices') {
        const session = authenticate(request)
        const input = await body(request)
        const deviceId = validIdentifier(input.deviceId, DEVICE_ID_PATTERN, 'A valid broker device ID is required.')
        const role = input.role === 'host' || input.role === 'client' ? input.role : null
        if (!role) throw new SyncServiceError('broker_device_invalid', 'Broker device role must be host or client.', 400)
        const label = normalizedDeviceLabel(input.label)
        const data = store.read()
        const account = data.accounts[session.username]
        if (!account) throw new SyncServiceError('account_missing', 'The account no longer exists.', 401)
        const broker = brokerFor(account)
        const existing = broker.devices[deviceId]
        if (existing && existing.role !== role) {
          throw new SyncServiceError('broker_device_conflict', 'That device ID is already registered with another role.', 409)
        }
        const token = randomBytes(32).toString('base64url')
        const registeredAt = new Date().toISOString()
        broker.devices[deviceId] = {
          id: deviceId,
          role,
          label,
          tokenHash: hashSecret(token),
          registeredAt: existing?.registeredAt ?? registeredAt,
          lastSeenAt: registeredAt,
          revokedAt: null,
        }
        store.write(data)
        return json(response, existing ? 200 : 201, {
          device: publicDevice(broker.devices[deviceId]),
          token,
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/broker/devices/revoke') {
        const session = authenticate(request)
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data)
        const revokedAt = new Date().toISOString()
        device.revokedAt = revokedAt
        for (const pairing of Object.values(broker.pairings)) {
          if (!pairing.revokedAt && (pairing.hostId === device.id || pairing.clientId === device.id)) {
            pairing.revokedAt = revokedAt
          }
        }
        store.write(data)
        return json(response, 200, { revoked: true, deviceId: device.id, revokedAt })
      }

      if (request.method === 'POST' && url.pathname === '/v1/broker/pairings') {
        const session = authenticate(request)
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'host')
        const code = pairingCode()
        const id = `pair_${randomBytes(16).toString('base64url')}`
        const createdAt = new Date().toISOString()
        const expiresAt = new Date(Date.now() + PAIRING_LIFETIME_MS).toISOString()
        broker.pairings[id] = {
          id,
          hostId: device.id,
          clientId: null,
          codeHash: hashSecret(code),
          createdAt,
          expiresAt,
          claimedAt: null,
          revokedAt: null,
        }
        store.write(data)
        return json(response, 201, {
          pairing: publicPairing(broker.pairings[id], broker),
          code,
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/broker/pairings/claim') {
        const session = authenticate(request)
        const input = await body(request)
        const suppliedCode = typeof input.code === 'string' ? input.code.trim().toUpperCase() : ''
        if (suppliedCode.length !== 8) {
          throw new SyncServiceError('broker_pairing_invalid', 'Enter the eight-character Host pairing code.', 400)
        }
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'client')
        const now = Date.now()
        const pairing = Object.values(broker.pairings).find((candidate) => candidate
          && !candidate.revokedAt
          && !candidate.claimedAt
          && Date.parse(candidate.expiresAt) > now
          && secretMatches(suppliedCode, candidate.codeHash))
        if (!pairing) {
          throw new SyncServiceError('broker_pairing_invalid', 'The Host pairing code is invalid or expired.', 404)
        }
        const host = broker.devices[pairing.hostId]
        if (!host || host.revokedAt || host.role !== 'host') {
          throw new SyncServiceError('broker_host_unavailable', 'The Host for that pairing code is unavailable.', 409)
        }
        pairing.clientId = device.id
        pairing.claimedAt = new Date().toISOString()
        delete pairing.codeHash
        store.write(data)
        return json(response, 200, { pairing: publicPairing(pairing, broker) })
      }

      if (request.method === 'GET' && url.pathname === '/v1/broker/hosts') {
        const session = authenticate(request)
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'client')
        const hosts = Object.values(broker.pairings)
          .filter((pairing) => pairing.clientId === device.id && pairing.claimedAt && !pairing.revokedAt)
          .map((pairing) => ({ pairing: publicPairing(pairing, broker), host: broker.devices[pairing.hostId] }))
          .filter((item) => item.host && !item.host.revokedAt)
          .map((item) => ({ ...publicDevice(item.host), pairedAt: item.pairing.claimedAt }))
        return json(response, 200, { hosts })
      }

      if (request.method === 'POST' && url.pathname === '/v1/broker/pairings/revoke') {
        const session = authenticate(request)
        const input = await body(request)
        const pairingId = validIdentifier(input.pairingId, DEVICE_ID_PATTERN, 'A valid broker pairing ID is required.')
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data)
        const pairing = broker.pairings[pairingId]
        if (!pairing || (pairing.hostId !== device.id && pairing.clientId !== device.id)) {
          throw new SyncServiceError('broker_pairing_not_found', 'That broker pairing is not available.', 404)
        }
        pairing.revokedAt ??= new Date().toISOString()
        store.write(data)
        return json(response, 200, { pairing: publicPairing(pairing, broker) })
      }

      if (request.method === 'POST' && url.pathname === '/v1/broker/jobs') {
        const session = authenticate(request)
        const input = await body(request)
        const jobId = validIdentifier(input.jobId, JOB_ID_PATTERN, 'A valid remote job ID is required.')
        const hostId = validIdentifier(input.hostId, DEVICE_ID_PATTERN, 'A valid target Host ID is required.')
        if (typeof input.requestHash !== 'string' || !HASH_PATTERN.test(input.requestHash) || !validBrokerEnvelope(input.envelope)) {
          throw new SyncServiceError('broker_job_invalid', 'A request hash and encrypted remote job are required.', 400)
        }
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'client')
        if (!activePairing(broker, hostId, device.id)) {
          throw new SyncServiceError('broker_host_not_paired', 'Pair this client with the selected Host before starting a remote job.', 403)
        }
        const existing = broker.jobs[jobId]
        if (existing) {
          if (existing.hostId !== hostId || existing.clientId !== device.id || existing.requestHash !== input.requestHash) {
            throw new SyncServiceError('broker_job_conflict', 'That remote job ID already belongs to another request.', 409)
          }
          return json(response, 200, { job: publicBrokerJob(existing) })
        }
        trimBrokerJobs(broker)
        const createdAt = new Date().toISOString()
        const job = {
          id: jobId,
          hostId,
          clientId: device.id,
          requestHash: input.requestHash,
          envelope: input.envelope,
          state: 'queued',
          createdAt,
          claimedAt: null,
          terminalAt: null,
          lastEventSequence: 0,
          events: [],
          commands: [],
        }
        broker.jobs[jobId] = job
        store.write(data)
        return json(response, 202, { job: publicBrokerJob(job) })
      }

      const hostJobsMatch = url.pathname.match(/^\/v1\/broker\/hosts\/([^/]+)\/jobs$/)
      if (request.method === 'GET' && hostJobsMatch) {
        const session = authenticate(request)
        const hostId = decodeURIComponent(hostJobsMatch[1])
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'host', hostId)
        device.lastSeenAt = new Date().toISOString()
        const jobs = Object.values(broker.jobs)
          .filter((job) => job.hostId === hostId && !TERMINAL_BROKER_STATES.has(job.state))
          .map((job) => ({
            ...publicBrokerJob(job),
            envelope: job.envelope,
          }))
        store.write(data)
        return json(response, 200, { jobs })
      }

      const jobClaimMatch = url.pathname.match(/^\/v1\/broker\/jobs\/([^/]+)\/claim$/)
      if (request.method === 'POST' && jobClaimMatch) {
        const session = authenticate(request)
        const jobId = decodeURIComponent(jobClaimMatch[1])
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'host')
        const job = brokerJobForDevice(broker, device, jobId)
        if (job.hostId !== device.id) throw new SyncServiceError('broker_job_forbidden', 'Only the selected Host may claim this job.', 403)
        const newlyClaimed = job.state === 'queued'
        if (newlyClaimed) {
          job.state = 'claimed'
          job.claimedAt = new Date().toISOString()
        }
        store.write(data)
        return json(response, 200, { job: { ...publicBrokerJob(job), envelope: job.envelope }, newlyClaimed })
      }

      const jobEventMatch = url.pathname.match(/^\/v1\/broker\/jobs\/([^/]+)\/events$/)
      if (request.method === 'POST' && jobEventMatch) {
        const session = authenticate(request)
        const jobId = decodeURIComponent(jobEventMatch[1])
        const input = await body(request)
        if (!Number.isSafeInteger(input.sequence) || input.sequence < 1
          || !BROKER_STATES.has(input.state) || !validBrokerEnvelope(input.envelope)) {
          throw new SyncServiceError('broker_event_invalid', 'A valid encrypted broker event and sequence are required.', 400)
        }
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'host')
        const job = brokerJobForDevice(broker, device, jobId)
        if (job.hostId !== device.id) throw new SyncServiceError('broker_job_forbidden', 'Only the selected Host may publish job events.', 403)
        const eventHash = hashSecret(JSON.stringify(input.envelope))
        const existing = job.events.find((event) => event.sequence === input.sequence)
        if (existing) {
          if (existing.envelopeHash !== eventHash || existing.state !== input.state) {
            throw new SyncServiceError('broker_event_conflict', 'That broker event sequence already contains another event.', 409)
          }
          return json(response, 200, { job: publicBrokerJob(job, { after: input.sequence - 1 }) })
        }
        if (input.sequence <= job.lastEventSequence) {
          throw new SyncServiceError('broker_event_out_of_order', 'Broker job events must advance the retained sequence.', 409, {
            afterSequence: job.lastEventSequence,
          })
        }
        job.events.push({
          sequence: input.sequence,
          state: input.state,
          envelope: input.envelope,
          envelopeHash: eventHash,
          createdAt: new Date().toISOString(),
        })
        job.lastEventSequence = input.sequence
        job.state = input.state
        if (TERMINAL_BROKER_STATES.has(input.state)) job.terminalAt ??= new Date().toISOString()
        if (job.events.length > MAX_BROKER_EVENTS_PER_JOB) job.events.splice(0, job.events.length - MAX_BROKER_EVENTS_PER_JOB)
        store.write(data)
        return json(response, 201, { job: publicBrokerJob(job, { after: input.sequence - 1 }) })
      }

      const jobCommandsMatch = url.pathname.match(/^\/v1\/broker\/jobs\/([^/]+)\/commands$/)
      if (request.method === 'POST' && jobCommandsMatch) {
        const session = authenticate(request)
        const jobId = decodeURIComponent(jobCommandsMatch[1])
        const input = await body(request)
        const commandId = validIdentifier(input.commandId, COMMAND_ID_PATTERN, 'A valid broker command ID is required.')
        const type = input.type === 'cancel' || input.type === 'steer' ? input.type : null
        if (!type || typeof input.requestHash !== 'string' || !HASH_PATTERN.test(input.requestHash) || !validBrokerEnvelope(input.envelope)) {
          throw new SyncServiceError('broker_command_invalid', 'A valid encrypted cancel or steer command is required.', 400)
        }
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'client')
        const job = brokerJobForDevice(broker, device, jobId)
        if (job.clientId !== device.id) throw new SyncServiceError('broker_job_forbidden', 'Only the paired client may control this job.', 403)
        if (TERMINAL_BROKER_STATES.has(job.state)) {
          throw new SyncServiceError('broker_job_finished', 'That remote job already finished and cannot accept another command.', 409)
        }
        const existing = job.commands.find((command) => command.id === commandId)
        if (existing) {
          if (existing.type !== type || existing.requestHash !== input.requestHash) {
            throw new SyncServiceError('broker_command_conflict', 'That broker command ID already belongs to another command.', 409)
          }
          return json(response, 200, { command: { ...existing } })
        }
        if (job.commands.length >= MAX_BROKER_COMMANDS_PER_JOB) {
          throw new SyncServiceError('broker_command_capacity', 'That remote job has too many retained commands.', 503)
        }
        const command = {
          id: commandId,
          sequence: (job.commands.at(-1)?.sequence ?? 0) + 1,
          type,
          requestHash: input.requestHash,
          envelope: input.envelope,
          createdAt: new Date().toISOString(),
          state: 'pending',
          claimedAt: null,
          ackEnvelope: null,
          ackedAt: null,
        }
        job.commands.push(command)
        store.write(data)
        return json(response, 202, { command: { ...command } })
      }

      if (request.method === 'GET' && jobCommandsMatch) {
        const session = authenticate(request)
        const jobId = decodeURIComponent(jobCommandsMatch[1])
        const after = Number(url.searchParams.get('after') ?? 0)
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'host')
        const job = brokerJobForDevice(broker, device, jobId)
        if (job.hostId !== device.id) throw new SyncServiceError('broker_job_forbidden', 'Only the selected Host may receive job commands.', 403)
        return json(response, 200, {
          commands: job.commands.filter((command) => command.sequence > after).map((command) => ({ ...command })),
        })
      }

      const commandClaimMatch = url.pathname.match(/^\/v1\/broker\/jobs\/([^/]+)\/commands\/([^/]+)\/claim$/)
      if (request.method === 'POST' && commandClaimMatch) {
        const session = authenticate(request)
        const jobId = decodeURIComponent(commandClaimMatch[1])
        const commandId = decodeURIComponent(commandClaimMatch[2])
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'host')
        const job = brokerJobForDevice(broker, device, jobId)
        if (job.hostId !== device.id) throw new SyncServiceError('broker_job_forbidden', 'Only the selected Host may claim job commands.', 403)
        const command = job.commands.find((item) => item.id === commandId)
        if (!command) throw new SyncServiceError('broker_command_not_found', 'That broker command is not available.', 404)
        const newlyClaimed = command.state === 'pending'
        if (newlyClaimed) {
          command.state = 'processing'
          command.claimedAt = new Date().toISOString()
          store.write(data)
        }
        return json(response, 200, { command: { ...command }, newlyClaimed })
      }

      const commandAckMatch = url.pathname.match(/^\/v1\/broker\/jobs\/([^/]+)\/commands\/([^/]+)\/ack$/)
      if (request.method === 'POST' && commandAckMatch) {
        const session = authenticate(request)
        const jobId = decodeURIComponent(commandAckMatch[1])
        const commandId = decodeURIComponent(commandAckMatch[2])
        const input = await body(request)
        if (!validBrokerEnvelope(input.envelope)) {
          throw new SyncServiceError('broker_command_ack_invalid', 'A valid encrypted command acknowledgement is required.', 400)
        }
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data, 'host')
        const job = brokerJobForDevice(broker, device, jobId)
        if (job.hostId !== device.id) throw new SyncServiceError('broker_job_forbidden', 'Only the selected Host may acknowledge job commands.', 403)
        const command = job.commands.find((item) => item.id === commandId)
        if (!command) throw new SyncServiceError('broker_command_not_found', 'That broker command is not available.', 404)
        const ackHash = hashSecret(JSON.stringify(input.envelope))
        if (command.ackEnvelope) {
          if (command.ackHash !== ackHash) {
            throw new SyncServiceError('broker_command_ack_conflict', 'That broker command already has another acknowledgement.', 409)
          }
          return json(response, 200, { command: { ...command } })
        }
        command.ackEnvelope = input.envelope
        command.ackHash = ackHash
        command.ackedAt = new Date().toISOString()
        command.state = 'acknowledged'
        store.write(data)
        return json(response, 200, { command: { ...command } })
      }

      const brokerJobMatch = url.pathname.match(/^\/v1\/broker\/jobs\/([^/]+)$/)
      if (request.method === 'GET' && brokerJobMatch) {
        const session = authenticate(request)
        const jobId = decodeURIComponent(brokerJobMatch[1])
        const after = Number(url.searchParams.get('after') ?? 0)
        const data = store.read()
        const { broker, device } = authenticateDevice(request, session, data)
        const job = brokerJobForDevice(broker, device, jobId)
        return json(response, 200, { job: publicBrokerJob(job, { after }) })
      }

      if (request.method === 'GET' && url.pathname === '/v1/workspace') {
        const session = authenticate(request)
        const workspace = store.read().accounts[session.username]?.workspace ?? null
        return json(response, 200, workspace ?? { revision: 0, document: null, updatedAt: null })
      }

      if (request.method === 'PUT' && url.pathname === '/v1/workspace') {
        const session = authenticate(request)
        const input = await body(request)
        if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || !validDocument(input.document)) {
          throw new SyncServiceError('workspace_invalid', 'A valid encrypted workspace and base revision are required.', 400)
        }
        const data = store.read()
        const account = data.accounts[session.username]
        if (!account) throw new SyncServiceError('account_missing', 'The account no longer exists.', 401)
        const current = account.workspace ?? { revision: 0, document: null, updatedAt: null }
        if (input.baseRevision !== current.revision) {
          throw new SyncServiceError('sync_revision_conflict', 'Newer synchronized conversations are available.', 409, current)
        }
        account.workspace = {
          revision: current.revision + 1,
          document: input.document,
          updatedAt: new Date().toISOString(),
        }
        store.write(data)
        return json(response, 200, account.workspace)
      }

      return json(response, 404, { error: 'Not found.', code: 'not_found' })
    } catch (error) {
      if (error instanceof SyncServiceError) {
        return json(response, error.status, {
          error: error.message,
          code: error.code,
          ...(error.details ?? {}),
        })
      }
      return json(response, 500, { error: 'Unexpected sync service error.', code: 'unexpected_sync_error' })
    }
  })
}

const isEntry = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isEntry) {
  const port = Number.parseInt(process.env.ENSYNC_SYNC_PORT ?? '43122', 10)
  const host = process.env.ENSYNC_SYNC_HOST ?? '127.0.0.1'
  const filePath = process.env.ENSYNC_SYNC_DATA_FILE ?? resolve('.ensync-sync-data.json')
  const server = createEnsyncSyncServer({ store: new FileSyncStore(filePath) })
  server.listen(port, host, () => {
    console.log(`Ensync Sync listening on http://${host}:${port}`)
  })
}

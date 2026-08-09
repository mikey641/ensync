import scryptModule from 'scrypt-js'

const { scrypt } = scryptModule

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function bytesToBase64Url(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function normalizedServiceUrl(value) {
  const url = new URL(String(value).trim())
  if (url.username || url.password || url.search || url.hash) throw new Error('The Sync URL cannot contain credentials, a query, or a fragment.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))) {
    throw new Error('Ensync Sync must use HTTPS unless it is running on this device.')
  }
  return url.href.replace(/\/$/, '')
}

function brokerAad({ username, hostId, clientId, jobId, kind, messageId }) {
  const values = [username, hostId, clientId, jobId, kind, String(messageId)]
  if (values.some((value) => !value || value.includes('\n'))) throw new Error('The broker encryption context is invalid.')
  return textEncoder.encode(['ensync-broker-v1', ...values].join('\n'))
}

async function requestHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(JSON.stringify(value)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function deriveKey(password, salt) {
  const bytes = await scrypt(textEncoder.encode(password), base64UrlToBytes(salt), 16_384, 8, 1, 32)
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encrypt(payload, key, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: brokerAad(context),
    tagLength: 128,
  }, key, textEncoder.encode(JSON.stringify(payload))))
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(sealed.subarray(0, -16)),
    tag: bytesToBase64Url(sealed.subarray(-16)),
  }
}

async function decrypt(document, key, context) {
  const ciphertext = base64UrlToBytes(document.ciphertext)
  const tag = base64UrlToBytes(document.tag)
  const sealed = new Uint8Array(ciphertext.length + tag.length)
  sealed.set(ciphertext)
  sealed.set(tag, ciphertext.length)
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: base64UrlToBytes(document.iv),
      additionalData: brokerAad(context),
      tagLength: 128,
    }, key, sealed)
    return JSON.parse(textDecoder.decode(plaintext))
  } catch {
    throw new Error('A remote execution message failed end-to-end authentication.')
  }
}

function stableClientId() {
  const storageKey = 'ensync-mobile-device-id-v1'
  const current = localStorage.getItem(storageKey)
  if (current && DEVICE_ID_PATTERN.test(current)) return current
  const created = `client_${crypto.randomUUID()}`
  localStorage.setItem(storageKey, created)
  return created
}

export class BrokerClient {
  constructor(serviceUrl) {
    this.baseUrl = normalizedServiceUrl(serviceUrl)
    this.deviceId = stableClientId()
    this.token = null
    this.deviceToken = null
    this.username = null
    this.key = null
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(this.deviceToken ? {
          'X-Ensync-Device-Id': this.deviceId,
          'X-Ensync-Device-Token': this.deviceToken,
        } : {}),
        ...options.headers,
      },
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(payload.error || `Ensync Sync failed (${response.status}).`)
      error.code = payload.code || 'sync_request_failed'
      throw error
    }
    return payload
  }

  async authenticate(mode, username, password) {
    const payload = await this.request(mode === 'register' ? '/v1/accounts' : '/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    this.username = payload.username
    this.token = payload.token
    this.key = await deriveKey(password, payload.encryptionSalt)
    const registration = await this.request('/v1/broker/devices', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: this.deviceId,
        role: 'client',
        label: `${navigator.platform || 'Mobile'} Ensync`,
      }),
    })
    this.deviceToken = registration.token
    return { username: this.username, device: registration.device }
  }

  async claimPairing(code) {
    const payload = await this.request('/v1/broker/pairings/claim', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
    return payload.pairing
  }

  async hosts() {
    return (await this.request('/v1/broker/hosts')).hosts
  }

  async submit({ hostId, provider, projectPath, prompt }) {
    const jobId = `job_${crypto.randomUUID()}`
    const clear = {
      version: 1,
      kind: 'local',
      request: {
        provider,
        projectPath,
        prompt,
        workspaceKey: `sync:${this.deviceId}:${jobId}`,
      },
    }
    const hash = await requestHash(clear)
    const envelope = await encrypt(clear, this.key, {
      username: this.username,
      hostId,
      clientId: this.deviceId,
      jobId,
      kind: 'run',
      messageId: jobId,
    })
    return (await this.request('/v1/broker/jobs', {
      method: 'POST',
      body: JSON.stringify({ hostId, jobId, requestHash: hash, envelope }),
    })).job
  }

  async job(jobId, after = 0) {
    const job = (await this.request(`/v1/broker/jobs/${encodeURIComponent(jobId)}?after=${after}`)).job
    const events = []
    for (const item of job.events) {
      const clear = await decrypt(item.envelope, this.key, {
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
    const envelope = await encrypt(clear, this.key, {
      username: this.username,
      hostId: job.hostId,
      clientId: job.clientId,
      jobId: job.id,
      kind: `command:${type}`,
      messageId: commandId,
    })
    return (await this.request(`/v1/broker/jobs/${encodeURIComponent(job.id)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ commandId, type, requestHash: await requestHash(clear), envelope }),
    })).command
  }
}

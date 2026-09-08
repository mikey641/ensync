import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

// Persists the non-secret identity of a provisioned Cloudflare Tunnel alongside
// the two secrets it needs to run, each encrypted by the caller's safe-storage
// implementation (Electron's safeStorage on the real shell). Secrets are never
// written or returned in plaintext.

export const CLOUDFLARE_TUNNEL_STORE_FILENAME = 'ensync-cloudflare-tunnel-v1.json'

const FORMAT = 'ensync-cloudflare-tunnel'
const VERSION = 1

function checksum(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const hostname = typeof value.hostname === 'string' ? value.hostname.trim() : ''
  const tunnelId = typeof value.tunnelId === 'string' ? value.tunnelId.trim() : ''
  const accountId = typeof value.accountId === 'string' ? value.accountId.trim() : ''
  if (!hostname || !tunnelId) return null
  const pid = Number.isInteger(value.pid) && value.pid >= 1 ? value.pid : null
  return Object.freeze({ hostname, tunnelId, accountId, pid })
}

export function createCloudflareTunnelStore({
  filePath,
  now = () => new Date().toISOString(),
  encrypt = (value) => value,
  decrypt = (value) => value,
} = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new TypeError('A Cloudflare Tunnel store path is required.')
  }
  const stagingPath = `${filePath}.staging`
  const backupPath = `${filePath}.backup`

  const decode = (encoded) => {
    try {
      const envelope = JSON.parse(encoded)
      if (!envelope || envelope.format !== FORMAT || envelope.version !== VERSION
        || typeof envelope.payload !== 'string' || envelope.checksum !== checksum(envelope.payload)) return null
      const identity = normalizeIdentity(JSON.parse(envelope.payload).identity)
      return identity ? { encoded, payload: JSON.parse(envelope.payload) } : null
    } catch {
      return null
    }
  }

  const readCandidate = (path, priority) => {
    try {
      const candidate = decode(readFileSync(path, 'utf8'))
      return candidate ? { ...candidate, path, priority } : null
    } catch {
      return null
    }
  }

  const readLatest = () => {
    const candidates = [readCandidate(filePath, 3), readCandidate(stagingPath, 2), readCandidate(backupPath, 1)]
      .filter(Boolean)
      .sort((left, right) => (right.payload.updatedAt ?? '').localeCompare(String(left.payload.updatedAt ?? '')) || right.priority - left.priority)
    return candidates[0] ?? null
  }

  const persist = (identity, credentials) => {
    const payload = JSON.stringify({
      identity,
      updatedAt: now(),
      apiTokenCipher: credentials.apiToken === null ? null : encrypt(credentials.apiToken),
      runTokenCipher: credentials.runToken === null ? null : encrypt(credentials.runToken),
    })
    const encoded = JSON.stringify({ format: FORMAT, version: VERSION, checksum: checksum(payload), payload })
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(stagingPath, encoded, { encoding: 'utf8', mode: 0o600 })
    const current = readCandidate(filePath, 3)
    if (current) writeFileSync(backupPath, current.encoded, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(filePath, encoded, { encoding: 'utf8', mode: 0o600 })
    try { rmSync(stagingPath) } catch { /* recovered on reopen */ }
  }

  return Object.freeze({
    identity() {
      const latest = readLatest()
      return latest ? normalizeIdentity(latest.payload.identity) : null
    },
    credentials() {
      const latest = readLatest()
      if (!latest) return null
      const payload = latest.payload
      if (typeof payload.apiTokenCipher !== 'string' || typeof payload.runTokenCipher !== 'string') return null
      try {
        const apiToken = decrypt(payload.apiTokenCipher)
        const runToken = decrypt(payload.runTokenCipher)
        if (typeof apiToken !== 'string' || !apiToken || typeof runToken !== 'string' || !runToken) return null
        return { apiToken, runToken }
      } catch {
        return null
      }
    },
    save({ hostname, tunnelId, accountId, apiToken, runToken, pid = null }) {
      const identity = normalizeIdentity({ hostname, tunnelId, accountId, pid })
      if (!identity) throw new TypeError('Valid tunnel identity (hostname + tunnel id) is required.')
      if (typeof apiToken !== 'string' || !apiToken || typeof runToken !== 'string' || !runToken) {
        throw new TypeError('A Cloudflare API token and tunnel run token are required.')
      }
      persist(identity, { apiToken, runToken })
      return identity
    },
    setPid(pid) {
      const current = readLatest()
      if (!current) return null
      const credentials = this.credentials()
      if (!credentials) return null
      const identity = { ...normalizeIdentity(current.payload.identity), pid: Number.isInteger(pid) && pid >= 1 ? pid : null }
      persist(identity, credentials)
      return identity
    },
    clear() {
      try { rmSync(filePath, { force: true }) } catch { /* nothing persisted to clear */ }
      try { rmSync(stagingPath, { force: true }) } catch { /* ignore */ }
      try { rmSync(backupPath, { force: true }) } catch { /* ignore */ }
    },
  })
}

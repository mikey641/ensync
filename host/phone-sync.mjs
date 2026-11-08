import { randomBytes, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { AccountSyncError } from './account-sync.mjs'
import { readJsonFile, writePrivateJson } from './host-secret-store.mjs'

export const DEFAULT_MOBILE_PWA_URL = 'https://ensync.vercel.app/mobile/'
const CREDENTIALS_SECRET = 'account-sync-credentials'
const STATE_FORMAT = 'ensync-phone-sync'
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/

function base64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function generatedCredentials() {
  // Satisfies the Sync password policy (length, four character classes) and
  // the username handle pattern. Never shown to the user.
  return {
    username: `ensync-${randomBytes(6).toString('hex')}`,
    password: `Ens-${randomBytes(24).toString('base64url')}-9aZ!`,
  }
}

function publicSyncUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())) return null
  return url.href.replace(/\/$/, '')
}

/**
 * One-shot phone linking for this computer: account, Host role, link token.
 * The account password lives only in OS-backed secret storage; non-secret
 * state (Host device ID, whether phone access is enabled) lives in a small
 * user-only JSON file so remote access resumes after a restart.
 */
export class PhoneSyncService {
  #accountSync
  #brokerHost
  #secrets
  #statePath
  #mobileUrl
  #publishCapabilities
  #log
  #restoring = null
  #linking = null

  constructor(options = {}) {
    if (!options.accountSyncService || !options.syncBrokerHost || !options.secretStore) {
      throw new TypeError('Account sync, broker Host, and secret store are required for phone sync.')
    }
    this.#accountSync = options.accountSyncService
    this.#brokerHost = options.syncBrokerHost
    this.#secrets = options.secretStore
    this.#statePath = typeof options.statePath === 'string' ? options.statePath : null
    this.#mobileUrl = typeof options.mobileUrl === 'string' && options.mobileUrl ? options.mobileUrl : DEFAULT_MOBILE_PWA_URL
    this.#publishCapabilities = typeof options.publishCapabilities === 'function' ? options.publishCapabilities : null
    this.#log = typeof options.log === 'function' ? options.log : () => {}
    this.restoreError = null
    this.state = null
  }

  async #readState() {
    if (!this.#statePath) return this.state
    const value = await readJsonFile(this.#statePath)
    this.state = value?.format === STATE_FORMAT && value.version === 1 ? value : null
    return this.state
  }

  async #writeState(patch) {
    const next = {
      format: STATE_FORMAT,
      version: 1,
      enabled: false,
      hostDeviceId: null,
      hostLabel: null,
      username: null,
      ...(this.state ?? {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    this.state = next
    if (this.#statePath) await writePrivateJson(this.#statePath, next)
    return next
  }

  async hostDeviceId() {
    const state = this.state ?? await this.#readState()
    return typeof state?.hostDeviceId === 'string' && DEVICE_ID_PATTERN.test(state.hostDeviceId)
      ? state.hostDeviceId
      : null
  }

  status() {
    return {
      enabled: this.state?.enabled === true,
      credentialStorage: this.#secrets.kind,
      restoreError: this.restoreError,
    }
  }

  /** Resume phone access after a Host restart when a phone was linked before. */
  restore() {
    this.#restoring ??= (async () => {
      const state = await this.#readState()
      if (!state?.enabled || !this.#accountSync.status().configured) return this.status()
      try {
        if (!this.#accountSync.status().authenticated) {
          const signedIn = await this.#signInWithStoredCredentials()
          if (!signedIn) {
            this.restoreError = { code: 'phone_sync_credentials_missing', message: 'Ensync could not find the saved account for phone sync. Show the QR code again.' }
            return this.status()
          }
        }
        await this.#ensureHost()
        this.restoreError = null
      } catch (error) {
        this.restoreError = { code: error?.code ?? 'phone_sync_restore_failed', message: error?.message ?? 'Phone sync could not resume.' }
        this.#log(`phone sync restore failed: ${this.restoreError.message}`)
      }
      return this.status()
    })().finally(() => { this.#restoring = null })
    return this.#restoring
  }

  async #storedCredentials() {
    try {
      const raw = await this.#secrets.get(CREDENTIALS_SECRET)
      const value = raw ? JSON.parse(raw) : null
      return typeof value?.username === 'string' && typeof value?.password === 'string' ? value : null
    } catch {
      return null
    }
  }

  async #signInWithStoredCredentials() {
    const stored = await this.#storedCredentials()
    if (!stored) return false
    const result = await this.#accountSync.login(stored)
    if (result?.stage === 'second_factor') {
      throw new AccountSyncError(
        'phone_sync_second_factor_required',
        'This account uses two-factor sign-in. Sign in under Advanced, then show the QR code again.',
        409,
      )
    }
    this.#accountSync.markCredentialStorage(this.#secrets.kind)
    return true
  }

  async #persistCurrentCredentials() {
    const credentials = this.#accountSync.credentialsForPersistence()
    if (!credentials || !this.#secrets.available()) return false
    const stored = await this.#storedCredentials()
    if (stored?.username !== credentials.username || stored?.password !== credentials.password) {
      await this.#secrets.set(CREDENTIALS_SECRET, JSON.stringify(credentials))
    }
    this.#accountSync.markCredentialStorage(this.#secrets.kind)
    return true
  }

  async #ensureSignedIn() {
    if (this.#accountSync.status().authenticated) return
    if (await this.#signInWithStoredCredentials()) return
    if (!this.#secrets.available()) {
      // Fail closed: an account whose only password is in memory would be
      // unrecoverable after a restart, and its encrypted history with it.
      throw new AccountSyncError(
        'secret_storage_unavailable',
        'This computer has no encrypted credential storage for an automatic account. Create or sign in to an account under Advanced instead.',
        503,
      )
    }
    const credentials = generatedCredentials()
    // Save first so a crash between the two steps can never leave a
    // registered account whose password nobody holds.
    await this.#secrets.set(CREDENTIALS_SECRET, JSON.stringify(credentials))
    try {
      await this.#accountSync.register(credentials)
    } catch (error) {
      await this.#secrets.delete(CREDENTIALS_SECRET).catch(() => {})
      throw error
    }
    this.#accountSync.markCredentialStorage(this.#secrets.kind)
  }

  async #ensureHost(label = null) {
    const device = this.#accountSync.brokerDevice()
    if (device?.role === 'client') {
      throw new AccountSyncError(
        'phone_sync_role_conflict',
        'This computer is registered as a remote client, so it cannot also link a phone. Restart Ensync and try again.',
        409,
      )
    }
    const status = this.#brokerHost.status()
    if (status.running && status.host?.role === 'host') return status.host
    const deviceId = device?.role === 'host'
      ? device.id
      : (await this.hostDeviceId()) ?? `host_${randomUUID()}`
    const hostLabel = (typeof label === 'string' && label.trim()) || this.state?.hostLabel || hostname() || 'This computer'
    const next = await this.#brokerHost.connect({ label: hostLabel.slice(0, 120), deviceId })
    await this.#writeState({ hostDeviceId: deviceId, hostLabel: next.host?.label ?? hostLabel })
    if (this.#publishCapabilities) void Promise.resolve(this.#publishCapabilities()).catch(() => {})
    return next.host
  }

  /**
   * Everything the QR needs, in one call. The link payload travels only in the
   * URL fragment, which browsers never send to a server.
   */
  createLink(input = {}) {
    this.#linking ??= this.#createLink(input).finally(() => { this.#linking = null })
    return this.#linking
  }

  async #createLink(input) {
    const status = this.#accountSync.status()
    if (!status.configured) {
      throw new AccountSyncError('sync_not_configured', 'Account sync is not configured for this Ensync build.', 503)
    }
    const sync = publicSyncUrl(input.syncUrl) ?? publicSyncUrl(status.serviceUrl)
    if (!sync) {
      throw new AccountSyncError(
        'phone_link_sync_url_unavailable',
        'Phone access is not published yet. Ensync needs a public HTTPS address for its Sync service before a phone can connect.',
        409,
      )
    }
    await this.#readState()
    await this.#ensureSignedIn()
    const persistent = await this.#persistCurrentCredentials().catch(() => false)
    const host = await this.#ensureHost(input.label)
    const { username, key } = this.#accountSync.linkSecret()
    await this.#writeState({ enabled: true, username })
    const link = await this.#accountSync.createBrokerLink(host.id)
    const fragment = base64url(JSON.stringify({
      v: 1,
      sync,
      token: link.token,
      username,
      key,
      hostId: host.id,
      hostLabel: host.label,
    }))
    return {
      url: `${this.#mobileUrl}#link=${fragment}`,
      expiresAt: link.expiresAt,
      persistent,
      host: { id: host.id, label: host.label },
    }
  }

  async listPhones() {
    if (!this.#accountSync.status().authenticated) return { phones: [] }
    const device = this.#accountSync.brokerDevice()
    if (device?.role !== 'host') return { phones: [] }
    const pairings = await this.#accountSync.listBrokerPairings()
    return {
      phones: pairings
        .filter((pairing) => pairing.host?.id === device.id && pairing.client)
        .map((pairing) => ({
          pairingId: pairing.id,
          deviceId: pairing.client.id,
          label: pairing.client.label,
          pairedAt: pairing.claimedAt,
          lastSeenAt: pairing.client.lastSeenAt ?? null,
        })),
    }
  }

  async revokePhone(pairingId) {
    if (typeof pairingId !== 'string' || !DEVICE_ID_PATTERN.test(pairingId)) {
      throw new AccountSyncError('broker_pairing_invalid', 'A valid phone pairing ID is required.', 400)
    }
    const device = this.#accountSync.brokerDevice()
    if (device?.role !== 'host') {
      throw new AccountSyncError('sync_broker_device_required', 'This computer is not sharing as a Host.', 409)
    }
    await this.#accountSync.revokeBrokerPairing(pairingId)
    return this.listPhones()
  }

  /** The user stopped remote access: do not resume it on the next start. */
  async disable() {
    await this.#readState()
    if (this.state) await this.#writeState({ enabled: false })
  }

  /** Signing out forgets the saved account and phone access entirely. */
  async forget() {
    await this.#readState()
    if (this.state) await this.#writeState({ enabled: false, username: null })
    await this.#secrets.delete(CREDENTIALS_SECRET).catch(() => {})
  }
}

import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

export const DEVICE_PREFERENCES_GET_CHANNEL = 'ensync:device-preferences:get'
export const COMPLETION_NOTIFICATION_PREFERENCES_SET_CHANNEL = 'ensync:device-preferences:set-completion-notifications'
export const UPDATE_CHANNEL_SET_CHANNEL = 'ensync:device-preferences:set-update-channel'
export const DEVICE_PREFERENCES_FILENAME = 'device-preferences-v1.json'

const FORMAT = 'ensync-device-preferences'
const VERSION = 1

function checksum(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeCompletionNotifications(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.mode !== 'off' && value.mode !== 'ringtone' && value.mode !== 'speech') return null
  if (typeof value.speechText !== 'string' || value.speechText.length > 240) return null
  if (value.voiceId !== null && (typeof value.voiceId !== 'string'
    || value.voiceId.length === 0 || value.voiceId.length > 1024)) return null
  return Object.freeze({
    mode: value.mode,
    speechText: value.speechText,
    voiceId: value.voiceId,
  })
}

function normalizeUpdateChannel(value) {
  return value === 'stable' || value === 'beta' ? value : null
}

function normalizePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const completionNotifications = value.completionNotifications === null
    ? null
    : normalizeCompletionNotifications(value.completionNotifications)
  if (value.completionNotifications !== null && !completionNotifications) return null
  const updateChannel = value.updateChannel === undefined
    ? 'stable'
    : normalizeUpdateChannel(value.updateChannel)
  if (!updateChannel) return null
  return Object.freeze({ completionNotifications, updateChannel })
}

function decode(encoded) {
  try {
    const envelope = JSON.parse(encoded)
    if (!envelope || envelope.format !== FORMAT || envelope.version !== VERSION
      || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1
      || typeof envelope.committedAt !== 'string' || Number.isNaN(Date.parse(envelope.committedAt))
      || typeof envelope.payload !== 'string' || envelope.checksum !== checksum(envelope.payload)) return null
    const preferences = normalizePreferences(JSON.parse(envelope.payload))
    return preferences ? { encoded, revision: envelope.revision, committedAt: envelope.committedAt, preferences } : null
  } catch {
    return null
  }
}

function encode(preferences, revision, committedAt) {
  const payload = JSON.stringify(preferences)
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    revision,
    committedAt,
    checksum: checksum(payload),
    payload,
  })
}

function publicPreferences(preferences) {
  return {
    completionNotifications: preferences.completionNotifications
      ? { ...preferences.completionNotifications }
      : null,
    updateChannel: preferences.updateChannel,
  }
}

export function createDevicePreferencesStore({ filePath, now = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('A device-preferences path is required.')
  const stagingPath = `${filePath}.staging`
  const backupPath = `${filePath}.backup`
  const readCandidate = (path, priority) => {
    try {
      const candidate = decode(readFileSync(path, 'utf8'))
      return candidate ? { ...candidate, path, priority } : null
    } catch {
      return null
    }
  }
  const candidates = [
    readCandidate(filePath, 3),
    readCandidate(stagingPath, 2),
    readCandidate(backupPath, 1),
  ].filter(Boolean).sort((left, right) => right.revision - left.revision
    || right.committedAt.localeCompare(left.committedAt) || right.priority - left.priority)
  let revision = candidates[0]?.revision ?? 0
  let preferences = candidates[0]?.preferences ?? Object.freeze({
    completionNotifications: null,
    updateChannel: 'stable',
  })

  if (candidates[0] && candidates[0].path !== filePath) {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, candidates[0].encoded, { encoding: 'utf8', mode: 0o600 })
    if (candidates[0].path === stagingPath) {
      try { rmSync(stagingPath) } catch {}
    }
  }

  const persist = (nextPreferences) => {
    const nextRevision = revision + 1
    const encoded = encode(nextPreferences, nextRevision, now())
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(stagingPath, encoded, { encoding: 'utf8', mode: 0o600 })
    const current = readCandidate(filePath, 3)
    if (current) writeFileSync(backupPath, current.encoded, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(filePath, encoded, { encoding: 'utf8', mode: 0o600 })
    try { rmSync(stagingPath) } catch {}
    revision = nextRevision
    preferences = nextPreferences
    return publicPreferences(preferences)
  }

  return Object.freeze({
    get() { return publicPreferences(preferences) },
    setCompletionNotifications(value) {
      const completionNotifications = normalizeCompletionNotifications(value)
      if (!completionNotifications) throw new TypeError('Valid completion-notification preferences are required.')
      return persist(Object.freeze({ ...preferences, completionNotifications }))
    },
    setUpdateChannel(value) {
      const updateChannel = normalizeUpdateChannel(value)
      if (!updateChannel) throw new TypeError('The update channel must be stable or beta.')
      return persist(Object.freeze({ ...preferences, updateChannel }))
    },
  })
}

export function createDevicePreferencesHandlers({ isAuthorized, store }) {
  if (typeof isAuthorized !== 'function' || !store) {
    throw new TypeError('Device-preferences authorization and store are required.')
  }
  return Object.freeze({
    get(event) {
      return isAuthorized(event) ? store.get() : null
    },
    setCompletionNotifications(event, value) {
      return isAuthorized(event) ? store.setCompletionNotifications(value) : null
    },
    setUpdateChannel(event, value) {
      return isAuthorized(event) ? store.setUpdateChannel(value) : null
    },
  })
}

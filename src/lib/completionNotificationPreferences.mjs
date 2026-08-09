export const COMPLETION_NOTIFICATIONS_STORAGE_KEY = 'ensync-completion-notifications-v1'

export const DEFAULT_COMPLETION_NOTIFICATION_SETTINGS = Object.freeze({
  mode: 'off',
  speechText: 'Your Ensync task is finished.',
  voiceId: null,
})

function isMode(value) {
  return value === 'off' || value === 'ringtone' || value === 'speech'
}

export function normalizeCompletionNotificationSettings(value) {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    mode: isMode(stored.mode) ? stored.mode : DEFAULT_COMPLETION_NOTIFICATION_SETTINGS.mode,
    speechText: typeof stored.speechText === 'string'
      ? stored.speechText.slice(0, 240)
      : DEFAULT_COMPLETION_NOTIFICATION_SETTINGS.speechText,
    voiceId: typeof stored.voiceId === 'string' && stored.voiceId.length > 0
      ? stored.voiceId.slice(0, 1024)
      : null,
  }
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function readCompletionNotificationSettings(storage = globalThis.localStorage) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { ...DEFAULT_COMPLETION_NOTIFICATION_SETTINGS }
  }
  try {
    const raw = storage.getItem(COMPLETION_NOTIFICATIONS_STORAGE_KEY)
    return raw
      ? normalizeCompletionNotificationSettings(safeJsonParse(raw))
      : { ...DEFAULT_COMPLETION_NOTIFICATION_SETTINGS }
  } catch {
    return { ...DEFAULT_COMPLETION_NOTIFICATION_SETTINGS }
  }
}

export function writeCompletionNotificationSettings(settings, storage = globalThis.localStorage) {
  const normalized = normalizeCompletionNotificationSettings(settings)
  try {
    storage?.setItem?.(COMPLETION_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Preferences remain usable for this session when browser storage is unavailable.
  }
  return normalized
}

function completionPreferencesBridge(target) {
  const bridge = target?.ensyncDesktop
  return bridge
    && typeof bridge.getDevicePreferences === 'function'
    && typeof bridge.setCompletionNotificationPreferences === 'function'
    ? bridge
    : null
}

/**
 * The native store is authoritative across renderer-origin or Chromium-storage
 * resets. On its first run, the existing localStorage value is migrated into
 * that store so current users keep their selected alert, text, and voice.
 */
export async function initializeCompletionNotificationPreferences(target = globalThis) {
  const localSettings = readCompletionNotificationSettings(target?.localStorage)
  const bridge = completionPreferencesBridge(target)
  if (!bridge) return localSettings

  try {
    const devicePreferences = await bridge.getDevicePreferences()
    const stored = devicePreferences?.completionNotifications
    const settings = stored && typeof stored === 'object'
      ? normalizeCompletionNotificationSettings(stored)
      : localSettings
    if (!stored) await bridge.setCompletionNotificationPreferences(settings)
    writeCompletionNotificationSettings(settings, target?.localStorage)
    return settings
  } catch {
    return localSettings
  }
}

export function saveCompletionNotificationPreferences(settings, target = globalThis) {
  const normalized = writeCompletionNotificationSettings(settings, target?.localStorage)
  const bridge = completionPreferencesBridge(target)
  if (bridge) {
    void Promise.resolve(bridge.setCompletionNotificationPreferences(normalized)).catch(() => {})
  }
  return normalized
}

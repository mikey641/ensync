export const COMPLETION_NOTIFICATIONS_STORAGE_KEY = 'ensync-completion-notifications-v1'

/** A run that has stopped and is waiting on the person before it can go on. */
export const ANSWER_NEEDED_ALERT = 'answer-needed'
/** A run that has finished and left something to read. */
export const TASK_FINISHED_ALERT = 'task-finished'

export const DEFAULT_COMPLETION_NOTIFICATION_SETTINGS = Object.freeze({
  mode: 'off',
  speechText: 'Your Ensync task is finished.',
  voiceId: null,
  answerAlerts: true,
  answerSpeechText: 'Your Ensync task needs an answer.',
})

function isMode(value) {
  return value === 'off' || value === 'ringtone' || value === 'speech'
}

/**
 * Settings stored before question alerts existed carry neither field, so both
 * default rather than reject: an alert the person never turned off is on.
 */
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
    answerAlerts: typeof stored.answerAlerts === 'boolean'
      ? stored.answerAlerts
      : DEFAULT_COMPLETION_NOTIFICATION_SETTINGS.answerAlerts,
    answerSpeechText: typeof stored.answerSpeechText === 'string'
      ? stored.answerSpeechText.slice(0, 240)
      : DEFAULT_COMPLETION_NOTIFICATION_SETTINGS.answerSpeechText,
  }
}

/**
 * What this device should play for one trigger. A question alert keeps its own
 * words and its own chime, because "come and decide" is not the same news as
 * "come and read"; the two share the mode and the voice so there is one alert
 * to configure, not two.
 */
export function completionAlertPlan(settings, trigger = TASK_FINISHED_ALERT) {
  const normalized = normalizeCompletionNotificationSettings(settings)
  const answerNeeded = trigger === ANSWER_NEEDED_ALERT
  const silent = { mode: 'off', chime: null, speechText: '', voiceId: normalized.voiceId }
  if (normalized.mode === 'off') return silent
  if (answerNeeded && !normalized.answerAlerts) return silent
  if (normalized.mode === 'ringtone') {
    return {
      mode: 'ringtone',
      chime: answerNeeded ? ANSWER_NEEDED_ALERT : TASK_FINISHED_ALERT,
      speechText: '',
      voiceId: normalized.voiceId,
    }
  }
  return {
    mode: 'speech',
    chime: null,
    speechText: answerNeeded ? normalized.answerSpeechText : normalized.speechText,
    voiceId: normalized.voiceId,
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

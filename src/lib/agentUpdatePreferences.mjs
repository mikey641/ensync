export const AGENT_UPDATE_PREFERENCES_KEY = 'ensync-agent-update-preferences-v1'
export const AGENT_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000

const MODES = new Set(['manual', 'remind', 'automatic'])

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

export function normalizeAgentUpdatePreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    mode: MODES.has(source.mode) ? source.mode : 'remind',
    lastReminderAt: validTimestamp(source.lastReminderAt),
    lastMaintenanceAt: validTimestamp(source.lastMaintenanceAt),
  }
}

export function readAgentUpdatePreferences(storage) {
  try {
    const value = storage?.getItem?.(AGENT_UPDATE_PREFERENCES_KEY)
    return normalizeAgentUpdatePreferences(value ? JSON.parse(value) : null)
  } catch {
    return normalizeAgentUpdatePreferences(null)
  }
}

export function writeAgentUpdatePreferences(storage, value) {
  const normalized = normalizeAgentUpdatePreferences(value)
  try {
    storage?.setItem?.(AGENT_UPDATE_PREFERENCES_KEY, JSON.stringify(normalized))
  } catch {
    // A private or full browser store must not make the settings UI unusable.
  }
  return normalized
}

export function agentUpdateDue(preferences, now = Date.now()) {
  const normalized = normalizeAgentUpdatePreferences(preferences)
  if (normalized.mode === 'manual') return false
  const anchor = normalized.mode === 'automatic'
    ? normalized.lastMaintenanceAt
    : [normalized.lastReminderAt, normalized.lastMaintenanceAt]
        .filter(Boolean)
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
  return anchor === null || now - Date.parse(anchor) >= AGENT_UPDATE_INTERVAL_MS
}

export function acknowledgeAgentUpdateReminder(preferences, at = new Date().toISOString()) {
  return normalizeAgentUpdatePreferences({
    ...preferences,
    lastReminderAt: at,
  })
}

export function recordAgentUpdateMaintenance(preferences, at = new Date().toISOString()) {
  return normalizeAgentUpdatePreferences({
    ...preferences,
    lastReminderAt: at,
    lastMaintenanceAt: at,
  })
}

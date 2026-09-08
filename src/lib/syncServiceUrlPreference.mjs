const SYNC_SERVICE_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** A usable Sync URL is HTTPS, or exact loopback HTTP for the local service. */
export function normalizeSyncServiceUrl(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
  if (parsed.protocol === 'http:' && !SYNC_SERVICE_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null
  return parsed.toString().replace(/\/$/, '')
}

/** Same rule as normalize, but an explicit non-empty value must actually pass. */
export function assertSyncServiceUrl(value) {
  if (value === null || value === undefined || value === '') return null
  const normalized = normalizeSyncServiceUrl(value)
  if (normalized === null) {
    throw new Error('Use an HTTPS Sync URL (or an exact loopback HTTP URL).')
  }
  return normalized
}

function syncServiceUrlBridge(target) {
  const bridge = target?.ensyncDesktop
  return bridge
    && typeof bridge.getDevicePreferences === 'function'
    && typeof bridge.setSyncServiceUrl === 'function'
    ? bridge
    : null
}

export function syncServiceUrlPreferenceAvailable(target = globalThis) {
  return syncServiceUrlBridge(target) !== null
}

export async function readSyncServiceUrl(target = globalThis) {
  const bridge = syncServiceUrlBridge(target)
  if (!bridge) return null
  try {
    const preferences = await bridge.getDevicePreferences()
    return typeof preferences?.syncServiceUrl === 'string' ? preferences.syncServiceUrl : null
  } catch {
    return null
  }
}

export async function writeSyncServiceUrl(value, target = globalThis) {
  const bridge = syncServiceUrlBridge(target)
  if (!bridge) throw new Error('The Sync service URL can be set from the Ensync desktop app.')
  const normalized = assertSyncServiceUrl(value)
  const preferences = await bridge.setSyncServiceUrl(normalized)
  return typeof preferences?.syncServiceUrl === 'string' ? preferences.syncServiceUrl : null
}

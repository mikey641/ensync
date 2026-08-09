export const PROVIDER_REFRESH_INTERVAL_MS = 60_000
export const PROVIDER_REFRESH_HIDDEN_INTERVAL_MS = 5 * 60_000
export const PROVIDER_REFRESH_OFFLINE_BASE_MS = 1_000
export const PROVIDER_REFRESH_OFFLINE_MAX_MS = 60_000

/**
 * Returns only the delay before the next real Host read. It never derives or modifies
 * provider telemetry; percentages, reset times, plans, and models remain CLI-owned.
 */
export function nextProviderRefreshDelay({ visible, online, consecutiveFailures = 0 }) {
  if (!visible) return PROVIDER_REFRESH_HIDDEN_INTERVAL_MS
  if (online) return PROVIDER_REFRESH_INTERVAL_MS

  const exponent = Math.max(0, Math.min(8, Number.isInteger(consecutiveFailures)
    ? consecutiveFailures - 1
    : 0))
  return Math.min(
    PROVIDER_REFRESH_OFFLINE_MAX_MS,
    PROVIDER_REFRESH_OFFLINE_BASE_MS * (2 ** exponent),
  )
}

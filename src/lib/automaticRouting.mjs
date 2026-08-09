/**
 * Automatic routing priority is a user preference, not provider catalog order.
 * Keep this allowlist limited to runners with tested chat execution.
 */
export const DEFAULT_FALLBACK_PROVIDER_ORDER = Object.freeze(['codex', 'claude'])

const AUTOMATIC_PROVIDER_IDS = new Set(DEFAULT_FALLBACK_PROVIDER_ORDER)

export function normalizeFallbackProviderOrder(value) {
  const requested = Array.isArray(value) ? value : []
  const unique = []
  for (const id of requested) {
    if (typeof id === 'string' && AUTOMATIC_PROVIDER_IDS.has(id) && !unique.includes(id)) {
      unique.push(id)
    }
  }
  for (const id of DEFAULT_FALLBACK_PROVIDER_ORDER) {
    if (!unique.includes(id)) unique.push(id)
  }
  return unique
}

export function orderedAutomaticProviders(providers, priorityOrder) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  return normalizeFallbackProviderOrder(priorityOrder)
    .map((id) => byId.get(id))
    .filter(Boolean)
}

function testedConnectedProvider(provider) {
  return provider.connected === true
    && provider.chatExecution === 'supported'
    && AUTOMATIC_PROVIDER_IDS.has(provider.id)
}

function exactUsedPercent(provider) {
  return typeof provider.usage === 'number' && Number.isFinite(provider.usage) && provider.usage >= 0
    ? provider.usage
    : null
}

/**
 * Select by the user's top-to-bottom priority, never by remaining-capacity size.
 * Unknown quota is not assumed available: it is considered only if no untried
 * provider has verified usage below 100%.
 */
export function selectAutomaticProvider(providers, priorityOrder, attemptedProviderIds = []) {
  const attempted = new Set(attemptedProviderIds)
  const candidates = orderedAutomaticProviders(providers, priorityOrder)
    .filter((provider) => testedConnectedProvider(provider) && !attempted.has(provider.id))
  const verifiedAvailable = candidates.find((provider) => {
    const usedPercent = exactUsedPercent(provider)
    return usedPercent !== null && usedPercent < 100
  })
  if (verifiedAvailable) return verifiedAvailable
  return candidates.find((provider) => exactUsedPercent(provider) === null) ?? null
}

/**
 * Provider telemetry can become stale while a renderer is suspended. Re-probe
 * once before declaring Auto unavailable, then select from the returned
 * snapshot so the caller does not have to wait for a React render cycle.
 */
export async function selectAutomaticProviderAfterRefresh(providers, priorityOrder, refreshProviders) {
  const selected = selectAutomaticProvider(providers, priorityOrder)
  if (selected || typeof refreshProviders !== 'function') return selected
  const refreshed = await refreshProviders()
  return Array.isArray(refreshed)
    ? selectAutomaticProvider(refreshed, priorityOrder)
    : null
}

/**
 * A provider run can invalidate the renderer snapshot that existed when the
 * turn started. Refresh local provider facts before choosing a safe runtime
 * fallback, while retaining the last verified snapshot if that refresh fails.
 */
export async function selectAutomaticFallbackProviderAfterRefresh(
  providers,
  priorityOrder,
  attemptedProviderIds,
  refreshProviders,
) {
  const current = selectAutomaticProvider(providers, priorityOrder, attemptedProviderIds)
  if (typeof refreshProviders !== 'function') return current
  let refreshed
  try {
    refreshed = await refreshProviders()
  } catch {
    return current
  }
  return Array.isArray(refreshed)
    ? selectAutomaticProvider(refreshed, priorityOrder, attemptedProviderIds)
    : current
}

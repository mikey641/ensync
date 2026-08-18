/**
 * Automatic routing priority is a user preference, not provider catalog order.
 * Keep this allowlist limited to runners with tested chat execution.
 */
export const DEFAULT_FALLBACK_PROVIDER_ORDER = Object.freeze(['codex', 'claude', 'droid'])

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
 * The provider a conversation displays must be a fact. An executing run owns the
 * current turn, so it always wins: re-resolving automatic routing on each render
 * is what let a mid-run usage refresh rename a streaming Codex turn to Claude
 * Code in the header. Callers that can observe a run must pass it.
 *
 * Once no run is executing, an automatic conversation shows where the next turn
 * would actually go, because automatic routing is re-resolved from live usage at
 * send time and never resumes the previous turn's provider by itself. Pinning an
 * idle Auto conversation to the provider that ran last is what showed Factory
 * Droid after a one-turn quota fallback while the next turn would have run on
 * Claude Code. The last Host-verified turn is kept only as the last resort, when
 * automatic routing currently has no candidate at all.
 *
 * Returns null when nothing is resolvable so callers keep their own last resort.
 */
export function conversationProviderId({ chat, activeRun, providers, priorityOrder }) {
  const available = new Set((providers ?? []).map((provider) => provider.id))
  const running = activeRun?.provider
  if (typeof running === 'string' && available.has(running)) return running
  if (chat?.providerMode === 'fixed') return typeof chat.provider === 'string' ? chat.provider : null
  const nextAutomatic = selectAutomaticProvider(providers ?? [], priorityOrder)?.id
  if (typeof nextAutomatic === 'string') return nextAutomatic
  const lastVerified = chat?.continuation?.provider
  if (typeof lastVerified === 'string' && available.has(lastVerified)) return lastVerified
  return null
}

/**
 * Refresh providers (if a refresh callback is provided), then select the next
 * automatic fallback provider that has not been attempted yet.
 */
export async function selectAutomaticFallbackProviderAfterRefresh(
  providers,
  priorityOrder,
  attemptedProviderIds = [],
  refreshProviders,
) {
  let current = providers
  if (typeof refreshProviders === 'function') {
    const refreshed = await refreshProviders()
    if (refreshed) current = refreshed
  }
  return selectAutomaticProvider(current, priorityOrder, attemptedProviderIds)
}

/**
 * Refresh providers (if a refresh callback is provided), then select the
 * automatic provider for a new conversation.
 */
export async function selectAutomaticProviderAfterRefresh(
  providers,
  priorityOrder,
  refreshProviders,
) {
  let current = providers
  if (typeof refreshProviders === 'function') {
    const refreshed = await refreshProviders()
    if (refreshed) current = refreshed
  }
  return selectAutomaticProvider(current, priorityOrder)
}

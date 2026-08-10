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
 * The provider a conversation displays must be a fact whenever one exists, never
 * a forecast re-derived on every render. An executing run owns the current turn,
 * and once it ends the last Host-verified turn still owns the conversation's
 * resumable session. Only a fixed preference or a conversation that has never run
 * falls back to the live automatic selection.
 *
 * Re-resolving automatic routing on each render is what let a mid-run usage
 * refresh rename a streaming Codex turn to Claude Code in the header.
 *
 * Returns null when nothing is resolvable so callers keep their own last resort.
 */
export function conversationProviderId({ chat, activeRun, providers, priorityOrder }) {
  const available = new Set((providers ?? []).map((provider) => provider.id))
  const running = activeRun?.provider
  if (typeof running === 'string' && available.has(running)) return running
  if (chat?.providerMode === 'fixed') return typeof chat.provider === 'string' ? chat.provider : null
  const lastVerified = chat?.continuation?.provider
  if (typeof lastVerified === 'string' && available.has(lastVerified)) return lastVerified
  return selectAutomaticProvider(providers ?? [], priorityOrder)?.id ?? null
}

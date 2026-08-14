/**
 * Availability ranking for the provider list.
 *
 * The list answers one question first: which agent can I actually send a turn to
 * right now? So a provider that reports verified remaining subscription capacity
 * leads, ordered by how much of that capacity is left. Ensync never estimates
 * capacity, so an unverified usage number is treated as unknown, never as free.
 *
 * Tested chat runners stay above discovery-only candidates even when they are
 * exhausted: a real runner whose window resets tonight is closer to usable than
 * a provider Ensync cannot route a turn through at all. The navigation order
 * breaks every remaining tie, so the list only moves when the facts move.
 */

const RANK_VERIFIED_CAPACITY = 0
const RANK_RUNNER_UNKNOWN_USAGE = 1
const RANK_RUNNER_EXHAUSTED = 2
const RANK_READY_DISCOVERY = 3
const RANK_INSTALLED_NOT_READY = 4
const RANK_NOT_INSTALLED = 5
const RANK_LOCAL_RUNTIME = 6

/**
 * Remaining subscription capacity, but only when the CLI actually reported it.
 * Returns null for unknown capacity so callers cannot confuse it with zero.
 */
export function verifiedRemainingPercent(provider) {
  const usage = provider?.usage
  if (!usage || usage.source !== 'cli') return null
  if (typeof usage.usedPercent !== 'number' || Number.isNaN(usage.usedPercent)) return null
  return Math.min(100, Math.max(0, 100 - usage.usedPercent))
}

export function availabilityRank(provider) {
  if (provider?.usage?.kind === 'local_runtime') return RANK_LOCAL_RUNTIME

  const ready = provider?.connectionState === 'ready'
  if (ready && provider?.chatExecution === 'supported') {
    const remaining = verifiedRemainingPercent(provider)
    if (remaining === null) return RANK_RUNNER_UNKNOWN_USAGE
    return remaining > 0 ? RANK_VERIFIED_CAPACITY : RANK_RUNNER_EXHAUSTED
  }
  if (ready) return RANK_READY_DISCOVERY
  return provider?.installed ? RANK_INSTALLED_NOT_READY : RANK_NOT_INSTALLED
}

/**
 * Orders providers by real availability, falling back to `navigationOrder` for
 * every tie. Returns a new array; the caller's list is left untouched.
 */
export function rankProvidersByAvailability(providers, navigationOrder = []) {
  const navigationRank = new Map(navigationOrder.map((id, index) => [id, index]))
  const fallbackRank = (id) => navigationRank.get(id) ?? Number.MAX_SAFE_INTEGER

  return [...providers].sort((left, right) => {
    const rankDelta = availabilityRank(left) - availabilityRank(right)
    if (rankDelta !== 0) return rankDelta

    if (availabilityRank(left) === RANK_VERIFIED_CAPACITY) {
      const capacityDelta = verifiedRemainingPercent(right) - verifiedRemainingPercent(left)
      if (capacityDelta !== 0) return capacityDelta
    }

    return fallbackRank(left.id) - fallbackRank(right.id)
  })
}

import { DEFAULT_FALLBACK_PROVIDER_ORDER, normalizeFallbackProviderOrder } from './automaticRouting.mjs'

/**
 * The Automatic fallback ranking is one device-wide choice, not workspace state.
 * Keeping it out of the UUID-namespaced workspace snapshot is what lets a change
 * made in one native window route Auto the same way in every other window.
 */
export const FALLBACK_PROVIDER_ORDER_KEY = 'ensync-automatic-fallback-order-v1'

function isDefaultOrder(order) {
  return order.length === DEFAULT_FALLBACK_PROVIDER_ORDER.length
    && order.every((id, index) => id === DEFAULT_FALLBACK_PROVIDER_ORDER[index])
}

/** Returns the saved device-wide ranking, or null when the user never chose one. */
export function readStoredFallbackProviderOrder(storage) {
  try {
    const value = storage?.getItem?.(FALLBACK_PROVIDER_ORDER_KEY)
    if (typeof value !== 'string' || !value) return null
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? normalizeFallbackProviderOrder(parsed) : null
  } catch {
    return null
  }
}

export function writeStoredFallbackProviderOrder(storage, order) {
  const normalized = normalizeFallbackProviderOrder(order)
  try {
    storage?.setItem?.(FALLBACK_PROVIDER_ORDER_KEY, JSON.stringify(normalized))
  } catch {
    // A private or full browser store must not make the routing settings unusable.
  }
  return normalized
}

/**
 * Resolves the ranking for a starting window. The device-wide choice always wins over
 * a workspace snapshot written before this preference moved out of workspace state.
 * A snapshot that still holds the default ranking is indistinguishable from "never
 * chosen", so it never migrates and never overwrites another window's explicit choice.
 */
export function resolveFallbackProviderOrder(storage, workspaceOrder) {
  const stored = readStoredFallbackProviderOrder(storage)
  if (stored) return stored
  if (!Array.isArray(workspaceOrder)) return normalizeFallbackProviderOrder(workspaceOrder)
  const migrated = normalizeFallbackProviderOrder(workspaceOrder)
  if (isDefaultOrder(migrated)) return migrated
  return writeStoredFallbackProviderOrder(storage, migrated)
}

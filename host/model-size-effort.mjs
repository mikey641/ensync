/**
 * Ensync's friendly Model size tiers and the provider reasoning effort each one
 * requests. This lives in host/ rather than src/lib/ for the same reason the
 * routing algorithm does: host/ is the only source directory the installed app
 * ships beside the daemon, so the connector API and the renderer read one table
 * instead of two that can drift.
 */
export const MODEL_SIZE_EFFORT = Object.freeze({
  small: 'low',
  medium: 'medium',
  large: 'high',
  xl: 'max',
})

export function effortForModelSize(sizeTier) {
  return MODEL_SIZE_EFFORT[sizeTier] ?? null
}

export function sizeForModelEffort(effort) {
  return Object.entries(MODEL_SIZE_EFFORT).find(([, candidate]) => candidate === effort)?.[0] ?? null
}

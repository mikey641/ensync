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

export function chatRunPreferences(chat, automaticFallback) {
  return {
    automaticProvider: chat.providerMode !== 'fixed',
    fallbackEnabled: Boolean(automaticFallback),
    requestedEffort: effortForModelSize(chat.sizeTier),
  }
}

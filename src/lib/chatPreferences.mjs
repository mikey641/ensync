import { effortForModelSize } from '../../host/model-size-effort.mjs'

// The size-tier table itself lives in host/model-size-effort.mjs so the daemon's
// connector API can request the same effort an Ensync conversation would.
export { MODEL_SIZE_EFFORT, effortForModelSize, sizeForModelEffort } from '../../host/model-size-effort.mjs'

export function chatRunPreferences(chat, automaticFallback) {
  return {
    automaticProvider: chat.providerMode !== 'fixed',
    fallbackEnabled: Boolean(automaticFallback),
    requestedEffort: effortForModelSize(chat.sizeTier),
  }
}

const DEFAULT_WINDOW_MS = 30_000
const DEFAULT_MAX_RELOADS = 2

export function isRecoverableRendererExit(details) {
  return Boolean(details && details.reason !== 'clean-exit')
}
/**
 * Bounds automatic renderer reloads so a broken UI build cannot trap the app
 * in an infinite crash loop. A renderer must stay loaded for the full window
 * before earlier crashes are forgotten.
 */
export function createRendererCrashRecovery(options = {}) {
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const maxReloads = options.maxReloads ?? DEFAULT_MAX_RELOADS
  let reloads = []
  let healthyTimer = null

  const clearHealthyTimer = () => {
    if (healthyTimer !== null) {
      (options.clearTimeout ?? clearTimeout)(healthyTimer)
      healthyTimer = null
    }
  }

  return {
    requestReload(details) {
      clearHealthyTimer()
      if (!isRecoverableRendererExit(details)) return false
      const cutoff = now() - windowMs
      reloads = reloads.filter((timestamp) => timestamp >= cutoff)
      if (reloads.length >= maxReloads) return false
      reloads.push(now())
      return true
    },
    rendererLoaded() {
      clearHealthyTimer()
      healthyTimer = (options.setTimeout ?? setTimeout)(() => {
        reloads = []
        healthyTimer = null
      }, windowMs)
    },
    dispose() {
      clearHealthyTimer()
      reloads = []
    },
  }
}

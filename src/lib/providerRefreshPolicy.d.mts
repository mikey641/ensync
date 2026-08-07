export const PROVIDER_REFRESH_INTERVAL_MS: number
export const PROVIDER_REFRESH_HIDDEN_INTERVAL_MS: number
export const PROVIDER_REFRESH_OFFLINE_BASE_MS: number
export const PROVIDER_REFRESH_OFFLINE_MAX_MS: number

export function nextProviderRefreshDelay(options: {
  visible: boolean
  online: boolean
  consecutiveFailures?: number
}): number

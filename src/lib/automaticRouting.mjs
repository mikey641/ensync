/**
 * The Automatic routing algorithm moved to host/automatic-routing.mjs because
 * host/ is the only source directory the installed app ships beside the daemon
 * (desktop/package.json copies ../host into Resources and never copies src/).
 * The renderer and the Host connector API must resolve Auto with one
 * implementation or an external bot would route differently from the app, so
 * this module stays as a re-export: existing renderer imports are unchanged.
 */
export {
  DEFAULT_FALLBACK_PROVIDER_ORDER,
  conversationProviderId,
  normalizeFallbackProviderOrder,
  orderedAutomaticProviders,
  selectAutomaticFallbackProviderAfterRefresh,
  selectAutomaticProvider,
  selectAutomaticProviderAfterRefresh,
} from '../../host/automatic-routing.mjs'

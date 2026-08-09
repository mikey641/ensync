const SAFE_PREFLIGHT_CODES = new Set([
  'provider_unavailable',
  'provider_not_authenticated',
  'subscription_auth_required',
  'run_start_failed',
  'provider_startup_failed',
])

const AMBIGUOUS_OR_UNSAFE_CODES = new Set([
  'run_timed_out',
  'run_output_exceeded',
  'invalid_cli_output',
  'empty_cli_response',
  'cli_failed',
  'invalid_bridge_response',
  'remote_bridge_failed',
])

/**
 * Treat safeToRetry as a Host proof, not as a general client-side hint. Runtime
 * quota fallback is accepted only under the provider_quota code, which the Host
 * emits after parsing a complete structured provider failure with zero observed
 * tool, command, file, or unknown work-item activity.
 */
export function safeFallbackProof(error) {
  if (!error || typeof error !== 'object' || error.safeToRetry !== true) return null
  const code = typeof error.code === 'string' ? error.code : null
  if (!code || AMBIGUOUS_OR_UNSAFE_CODES.has(code)) return null
  if (code === 'provider_quota') return { kind: 'quota', code }
  if (SAFE_PREFLIGHT_CODES.has(code)) return { kind: 'preflight', code }
  return null
}

export function appendFallbackReason(previous, next) {
  if (typeof next !== 'string' || !next.trim()) return previous ?? null
  return previous ? `${previous} -> ${next}` : next
}

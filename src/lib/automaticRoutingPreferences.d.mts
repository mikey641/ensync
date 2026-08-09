import type { ProviderId } from '../types'

export const FALLBACK_PROVIDER_ORDER_KEY: string

export function readStoredFallbackProviderOrder(
  storage?: Pick<Storage, 'getItem'> | null,
): ProviderId[] | null

export function writeStoredFallbackProviderOrder(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  order: unknown,
): ProviderId[]

export function subscribeStoredFallbackProviderOrder(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null | undefined,
  storage: Pick<Storage, 'getItem'> | null | undefined,
  onChange: (order: ProviderId[]) => void,
): () => void

export function resolveFallbackProviderOrder(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined,
  workspaceOrder: unknown,
): ProviderId[]

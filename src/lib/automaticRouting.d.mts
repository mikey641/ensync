import type { Chat, Provider, ProviderId } from '../types'

export const DEFAULT_FALLBACK_PROVIDER_ORDER: readonly ProviderId[]

export function normalizeFallbackProviderOrder(value: unknown): ProviderId[]

export function orderedAutomaticProviders(
  providers: Provider[],
  priorityOrder: readonly ProviderId[],
): Provider[]

export function selectAutomaticProvider(
  providers: Provider[],
  priorityOrder: readonly ProviderId[],
  attemptedProviderIds?: readonly ProviderId[],
): Provider | null

export function conversationProviderId(input: {
  chat: Chat | undefined
  activeRun: { provider?: ProviderId } | undefined
  providers: Provider[]
  priorityOrder: readonly ProviderId[]
}): ProviderId | null

export function selectAutomaticFallbackProviderAfterRefresh(
  providers: Provider[],
  priorityOrder: readonly ProviderId[],
  attemptedProviderIds?: readonly ProviderId[],
  refreshProviders?: () => Promise<Provider[] | null>,
): Promise<Provider | null>

export function selectAutomaticProviderAfterRefresh(
  providers: Provider[],
  priorityOrder: readonly ProviderId[],
  refreshProviders?: () => Promise<Provider[] | null>,
): Promise<Provider | null>

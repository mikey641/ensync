import type { Chat, ModelSizeTier } from '../types'
import type { ChatModelEffort } from './relayHost'

export const MODEL_SIZE_EFFORT: Readonly<Record<ModelSizeTier, ChatModelEffort>>

export function effortForModelSize(sizeTier: ModelSizeTier | null | undefined): ChatModelEffort | null

export function sizeForModelEffort(effort: ChatModelEffort | null | undefined): ModelSizeTier | null

export function chatRunPreferences(
  chat: Pick<Chat, 'providerMode' | 'sizeTier'>,
  automaticFallback: boolean,
): {
  automaticProvider: boolean
  fallbackEnabled: boolean
  requestedEffort: ChatModelEffort | null
}

import type { DeliveryRecord, DeliveryStatus } from './ensyncHost'
import type { Message } from '../types'

export function scopeDeliveryStatusForBranch(status: DeliveryStatus | null | undefined, sourceBranch: string): DeliveryStatus
export function activeDeliveryPromptContext(
  delivery: DeliveryRecord | null | undefined,
  productionDelivery: DeliveryRecord | null | undefined,
  messages: Message[] | null | undefined,
  activeTurnId: string | null | undefined,
): { hasUnsavedActivePrompt: boolean; activePrompt: Message | null }

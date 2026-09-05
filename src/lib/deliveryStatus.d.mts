import type { DeliveryRecord, DeliveryStatus } from './ensyncHost'
import type { Message } from '../types'

export function scopeDeliveryStatusForBranch(status: DeliveryStatus | null | undefined, sourceBranch: string): DeliveryStatus
export function deliveryPromptContext(
  delivery: DeliveryRecord | null | undefined,
  productionDelivery: DeliveryRecord | null | undefined,
  messages: Message[] | null | undefined,
  activeTurnId: string | null | undefined,
  events?: Array<{ type?: string; code?: string | null; message?: string | null }> | null,
): {
  prompt: Message | null
  promptIsActive: boolean
  hasUnsavedActivePrompt: boolean
  deliveryTracksPrompt: boolean
  deliveryLinkProof: 'journal' | 'completed_run' | null
}

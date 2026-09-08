import type { DeliveryRecord, DeliveryStatus } from './ensyncHost'
import type { Message } from '../types'

export function scopeDeliveryStatusForBranch(status: DeliveryStatus | null | undefined, sourceBranch: string): DeliveryStatus
export function verifiedProductionDeliveryEntries(status: DeliveryStatus | null | undefined): Array<{
  key: string
  productionAt: string | null
}>
export function verifiedProductionDeliveryKeys(status: DeliveryStatus | null | undefined): string[]
export function productionNotificationsNeedingAlert(
  entries: Array<{ key: string, productionAt: string | null }>,
  announcedKeys: Set<string>,
  options?: { hydrated?: boolean, nowMs?: number, initialGraceMs?: number },
): { alert: boolean, alertKeys: string[], announced: Set<string> }
export function deliveryPromptContext(
  delivery: DeliveryRecord | null | undefined,
  productionDelivery: DeliveryRecord | null | undefined,
  messages: Message[] | null | undefined,
  activeTurnId: string | null | undefined,
): {
  prompt: Message | null
  promptIsActive: boolean
  hasUnsavedActivePrompt: boolean
  deliveryTracksPrompt: boolean
  deliveryLinkProof: 'host' | null
}

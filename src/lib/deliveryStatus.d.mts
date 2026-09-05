import type { DeliveryStatus } from './ensyncHost'

export function scopeDeliveryStatusForBranch(status: DeliveryStatus | null | undefined, sourceBranch: string): DeliveryStatus

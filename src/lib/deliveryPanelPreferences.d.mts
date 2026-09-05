export const DEFAULT_DELIVERY_PANEL_OPEN: false

export function normalizeDeliveryPanelOpenByChat(value: unknown): Record<string, boolean>
export function deliveryPanelOpenForChat(preferences: Readonly<Record<string, boolean>>, chatId: string): boolean
export function setDeliveryPanelOpenForChat(
  preferences: Readonly<Record<string, boolean>>,
  chatId: string,
  open: boolean,
): Record<string, boolean>

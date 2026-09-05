export const DEFAULT_DELIVERY_PANEL_OPEN = false

export function normalizeDeliveryPanelOpenByChat(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value).filter(([chatId, open]) => chatId.trim().length > 0 && typeof open === 'boolean'),
  )
}

export function deliveryPanelOpenForChat(preferences, chatId) {
  return preferences[chatId] ?? DEFAULT_DELIVERY_PANEL_OPEN
}

export function setDeliveryPanelOpenForChat(preferences, chatId, open) {
  if (typeof chatId !== 'string' || chatId.trim().length === 0) {
    throw new TypeError('Delivery panel preferences require a non-empty chat ID.')
  }
  if (typeof open !== 'boolean') {
    throw new TypeError('Delivery panel preferences require a boolean open state.')
  }
  if (preferences[chatId] === open) return preferences
  return { ...preferences, [chatId]: open }
}

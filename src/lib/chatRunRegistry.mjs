function assertChatId(chatId) {
  if (typeof chatId !== 'string' || !chatId.trim()) {
    throw new TypeError('A non-empty chat ID is required.')
  }
}

/**
 * Tracks active runs by stable conversation ID. The registry is synchronous so
 * two submits in the same render frame cannot start duplicate work for one chat.
 */
export function createChatRunRegistry() {
  const activeChatIds = new Set()

  return Object.freeze({
    begin(chatId) {
      assertChatId(chatId)
      if (activeChatIds.has(chatId)) return false
      activeChatIds.add(chatId)
      return true
    },
    finish(chatId) {
      assertChatId(chatId)
      return activeChatIds.delete(chatId)
    },
    has(chatId) {
      assertChatId(chatId)
      return activeChatIds.has(chatId)
    },
    snapshot() {
      return new Set(activeChatIds)
    },
  })
}

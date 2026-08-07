function assertChatId(chatId) {
  if (typeof chatId !== 'string' || !chatId.trim()) {
    throw new TypeError('A non-empty chat ID is required.')
  }
}

/** Owns one independent cancellation signal for each active conversation run. */
export function createChatRunCancellationRegistry() {
  const controllers = new Map()
  return Object.freeze({
    begin(chatId) {
      assertChatId(chatId)
      const controller = new AbortController()
      controllers.set(chatId, controller)
      return controller
    },
    stop(chatId) {
      assertChatId(chatId)
      const controller = controllers.get(chatId)
      if (!controller || controller.signal.aborted) return false
      controller.abort()
      return true
    },
    finish(chatId, controller) {
      assertChatId(chatId)
      if (controllers.get(chatId) !== controller) return false
      return controllers.delete(chatId)
    },
  })
}

function storedText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function storedMessageText(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Builds the sticky context header exclusively from values already stored on the chat.
 * No fallback labels or generated summaries belong in this view model.
 */
export function storedChatContext(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : []
  let latestUserMessage = null

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue
    latestUserMessage = storedMessageText(messages[index]?.content)
    if (latestUserMessage) break
  }

  return {
    title: storedText(chat?.title),
    summary: storedText(chat?.subtitle),
    latestUserMessage,
  }
}

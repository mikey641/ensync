export function latestCompletedAgentMessageId(chat) {
  const latestMessage = chat?.messages?.at(-1)
  return latestMessage?.role === 'agent' && typeof latestMessage.id === 'string'
    ? latestMessage.id
    : null
}

export function markCompletionRead(readCompletionByChat, chatId, messageId) {
  if (!chatId || !messageId || readCompletionByChat[chatId] === messageId) {
    return readCompletionByChat
  }

  return { ...readCompletionByChat, [chatId]: messageId }
}

export function markChatCompletionRead(readCompletionByChat, chat) {
  return markCompletionRead(
    readCompletionByChat,
    chat?.id,
    latestCompletedAgentMessageId(chat),
  )
}

export function unreadCompletionTabIds({
  tabs,
  chats,
  sendingChatIds,
  readCompletionByChat,
}) {
  const chatsById = new Map(chats.map((chat) => [chat.id, chat]))
  const sending = sendingChatIds instanceof Set
    ? sendingChatIds
    : new Set(sendingChatIds)

  return tabs.flatMap((tab) => {
    const chat = chatsById.get(tab.chatId)
    const completionMessageId = latestCompletedAgentMessageId(chat)
    return completionMessageId
      && !sending.has(tab.chatId)
      && readCompletionByChat[tab.chatId] !== completionMessageId
      ? [tab.id]
      : []
  })
}

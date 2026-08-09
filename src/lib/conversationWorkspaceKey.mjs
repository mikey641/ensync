const MAX_CHAT_ID_CHARACTERS = 480
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const KEY_PREFIX = 'conversation:'
const LEGACY_OBJECT_PREFIX = '[object Object]:'

function validChatId(value) {
  return typeof value === 'string'
    && Boolean(value.trim())
    && value.length <= MAX_CHAT_ID_CHARACTERS
    && !CONTROL_CHARACTERS.test(value)
}

/**
 * Mint the provider-neutral identity used by Ensync Host to reuse one protected
 * worktree for every turn in an exact conversation.
 */
export function conversationWorkspaceKey(chatId) {
  if (!validChatId(chatId)) {
    throw new TypeError('A stable Ensync conversation ID is required before agent execution.')
  }
  return `${KEY_PREFIX}${chatId}`
}

/**
 * Preserve worktrees created by the first workspace-isolation renderer, which
 * accidentally stringified its native identity object. New and previously
 * unisolated chats always receive the explicit conversation key above.
 */
export function resolveConversationWorkspaceKey(chat) {
  const current = conversationWorkspaceKey(chat?.id)
  const legacy = `${LEGACY_OBJECT_PREFIX}${chat.id}`
  if (chat?.agentWorkspaceKey === current || chat?.agentWorkspaceKey === legacy) {
    return chat.agentWorkspaceKey
  }
  return chat?.workspace?.path && chat?.workspace?.branch ? legacy : current
}

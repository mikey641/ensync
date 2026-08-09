export type ConversationWorkspaceChat = {
  id: string
  agentWorkspaceKey?: string
  workspace?: { path: string; branch: string } | null
}

export function conversationWorkspaceKey(chatId: string): string
export function resolveConversationWorkspaceKey(chat: ConversationWorkspaceChat): string

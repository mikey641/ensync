import type { Chat, WorkspaceTab } from '../types'

export type CompletionReadState = Record<string, string>

export function latestCompletedAgentMessageId(chat: Chat | null | undefined): string | null
export function markCompletionRead(
  readCompletionByChat: CompletionReadState,
  chatId: string | null | undefined,
  messageId: string | null | undefined,
): CompletionReadState
export function markChatCompletionRead(
  readCompletionByChat: CompletionReadState,
  chat: Chat | null | undefined,
): CompletionReadState
export function unreadCompletionTabIds(options: {
  tabs: WorkspaceTab[]
  chats: Chat[]
  sendingChatIds: ReadonlySet<string> | readonly string[]
  readCompletionByChat: CompletionReadState
}): string[]

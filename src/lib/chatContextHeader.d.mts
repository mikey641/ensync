import type { Chat } from '../types'

export type StoredChatContext = {
  title: string | null
  summary: string | null
  latestUserMessage: string | null
}

export function storedChatContext(
  chat: Pick<Chat, 'title' | 'subtitle' | 'messages'>,
): StoredChatContext

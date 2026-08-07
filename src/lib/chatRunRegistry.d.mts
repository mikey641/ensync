export type ChatRunRegistry = Readonly<{
  begin(chatId: string): boolean
  finish(chatId: string): boolean
  has(chatId: string): boolean
  snapshot(): Set<string>
}>

export function createChatRunRegistry(): ChatRunRegistry

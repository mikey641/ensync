export type ChatRunCancellationRegistry = Readonly<{
  begin(chatId: string): AbortController
  stop(chatId: string): boolean
  finish(chatId: string, controller: AbortController): boolean
}>

export function createChatRunCancellationRegistry(): ChatRunCancellationRegistry

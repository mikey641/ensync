export function mergeImportedConversationState<T extends object>(currentState: T, candidate: object): {
  state: T
  summary: { addedChat: boolean; addedTab: boolean; addedMessages: number; chatId: string; tabId: string }
}

export function initializeNativeConversationImport(target?: typeof globalThis): Promise<{
  status: 'unavailable' | 'already_applied' | 'applied'
  summary?: { addedChat: boolean; addedTab: boolean; addedMessages: number; chatId: string; tabId: string }
  commit?: { revision: number; committedAt: string; source: string }
}>

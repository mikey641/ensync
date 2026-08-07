export type ChatScrollMetrics = {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export type ChatAutoScrollState = {
  pinned: boolean
  pendingLatest: boolean
}

export type ChatAutoScrollEvent =
  | { type: 'activate' | 'jump' | 'content' }
  | { type: 'scroll'; metrics: ChatScrollMetrics; threshold?: number }

export const CHAT_AUTO_SCROLL_THRESHOLD: number
export function chatScrollDistanceFromBottom(metrics: ChatScrollMetrics): number
export function chatScrollIsNearBottom(metrics: ChatScrollMetrics, threshold?: number): boolean
export function initialChatAutoScrollState(): ChatAutoScrollState
export function transitionChatAutoScroll(state: ChatAutoScrollState, event: ChatAutoScrollEvent): {
  state: ChatAutoScrollState
  scrollToLatest: boolean
}
export function chatAutoScrollContentRevision(input: {
  messages?: Array<{ id?: string; role?: string; deliveryStatus?: string; content?: string }>
  executionEvents?: Array<Record<string, unknown>>
  sending?: boolean
  queuedPrompts?: Array<{ id?: string; turnId?: string }>
  error?: string | null
}): string

export const ACCOUNT_WORKSPACE_FORMAT: 'ensync-account-conversations'
export const ACCOUNT_WORKSPACE_VERSION: 1

export type AccountWorkspace = {
  format: typeof ACCOUNT_WORKSPACE_FORMAT
  version: typeof ACCOUNT_WORKSPACE_VERSION
  chats: Array<Record<string, unknown>>
  projects: Array<Record<string, unknown>>
}

export function prepareAccountWorkspace(state: Record<string, unknown>): AccountWorkspace
export function isAccountWorkspace(value: unknown): value is AccountWorkspace
export function mergeAccountWorkspace<T extends Record<string, unknown>>(
  localState: T,
  remoteValue: unknown,
): { state: T; importedChats: number; totalChats: number }

export type AccountLiveTurnNote = {
  provider?: string
  text: string
  redacted: boolean
  at?: string
}

/** Transient progress of a turn that is still running, mirrored to other devices. */
export type AccountLiveTurn = {
  turnId: string
  status: 'running'
  provider: string
  startedAt: string
  updatedAt: string
  origin: 'desktop' | 'host'
  messageId?: string
  jobId?: string
  notes: AccountLiveTurnNote[]
}

export const LIVE_TURN_NOTE_LIMIT: number
export const LIVE_TURN_NOTE_MAX_CHARACTERS: number
export const LIVE_TURN_HEARTBEAT_MS: number
export const LIVE_TURN_STALE_MS: number

export function portableLiveTurn(value: unknown): AccountLiveTurn | undefined
export function liveTurnSettled(messages: unknown, liveTurn: AccountLiveTurn | null | undefined): boolean
export function activeLiveTurn(chat: unknown, nowMs?: number): AccountLiveTurn | null
export function buildLiveTurn(input: {
  turnId: string
  provider: string
  startedAt: string
  events?: ReadonlyArray<{ type?: string; provider?: string; text?: string; redacted?: boolean; at?: string }>
  heartbeatAt?: string | null
  origin?: 'desktop' | 'host'
  messageId?: string
  jobId?: string
}): AccountLiveTurn | null
export type AccountLiveQueueItem = { messageId?: string; turnId?: string; jobId?: string; queuedAt?: string }
export type AccountLiveQueueBlock = { updatedAt: string; items: AccountLiveQueueItem[] }

export function withLiveTurns<T extends { id: string }>(
  chats: readonly T[],
  liveTurns: Record<string, AccountLiveTurn> | null | undefined,
  liveQueues?: Record<string, AccountLiveQueueBlock> | null,
): T[]
export function desktopQueueBlock(
  prompts: ReadonlyArray<{ messageId?: string; turnId?: string; enqueuedAt?: string }> | null | undefined,
  heartbeatAt?: string | null,
): AccountLiveQueueBlock | null
export function activeQueuedTurns(chat: unknown, nowMs?: number): Array<AccountLiveQueueItem & { origin: 'host' | 'desktop' }>
export function portableLiveQueue(value: unknown): Partial<Record<'host' | 'desktop', AccountLiveQueueBlock>> | undefined
export function withLiveQueue<T>(chat: T, origin: 'host' | 'desktop', items: AccountLiveQueueItem[], updatedAt: string): T


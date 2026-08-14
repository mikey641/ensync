import type { Chat, FileAttachment, Message, ModelSizeTier, ProviderId } from '../types'

export type QueuedPrompt = {
  id: string
  turnId: string
  messageId: string
  prompt: string
  attachments?: FileAttachment[]
  enqueuedAt: string
  predecessorTurnId: string | null
  resumeApprovedAt?: string | null
  preferences: {
    providerMode: 'auto' | 'fixed'
    provider: ProviderId
    sizeTier: ModelSizeTier | null
    automaticFallback: boolean
    autoContextSkill: boolean
    fallbackProviderOrder: ProviderId[]
    executionTargetKey: string
    projectId: string
    projectPath: string
  }
}

export type PromptQueues = Record<string, QueuedPrompt[]>

export function normalizePromptQueues(value: unknown): PromptQueues
export function appendPromptToQueue(queues: PromptQueues, chatId: string, entry: QueuedPrompt): PromptQueues
export function removePromptFromQueue(queues: PromptQueues, chatId: string, entryId: string): PromptQueues
export function markQueuedMessageTransferred(messages: Message[], messageId: string): Message[]
export function acceptTransferredPrompt(
  queues: PromptQueues,
  chats: Chat[],
  chatId: string,
  entry: QueuedPrompt,
):
  | { status: 'accepted'; queues: PromptQueues; chats: Chat[] }
  | { status: 'duplicate'; alreadyConsumed: boolean; queues: PromptQueues; chats: Chat[] }
  | { status: 'conflict'; queues: PromptQueues; chats: Chat[] }
export function promoteQueuedPromptToActiveTurn(queues: PromptQueues, chatId: string, entryId: string, activeTurnId: string): PromptQueues
export function approveNextQueuedPrompt(queues: PromptQueues, chatId: string, approvedAt: string): PromptQueues
export function predecessorTurnIdForPrompt(queue: QueuedPrompt[], messages: Message[], inFlightRun?: { turnId?: string } | null): string | null
export type SteerableActiveRun = {
  turnId?: string
  provider?: string
  executionTarget?: string
  providerProcessStarted?: boolean
  jobId?: string
  projectId?: string
  projectPath?: string
}
export function activeCodexTurnCanAcceptSteering(activeRun: SteerableActiveRun | null | undefined): boolean
export function queuedPromptCanSteerActiveTurn(entry: QueuedPrompt | undefined, activeRun: SteerableActiveRun | null | undefined): boolean
export function queuedPromptCanStopAndSendNow(
  entry: QueuedPrompt | undefined | null,
  activeRun: SteerableActiveRun | null | undefined,
  options?: { liveSteerAvailable?: boolean },
): boolean
export type OccupiedRunOwner = {
  ownerJobId?: string
  jobId?: string
  provider?: string
  targetKind?: string
  nativeWorkspaceId?: string
  projectId?: string
  projectPath?: string
  chatId?: string
  providerProcessStarted?: boolean
  steerable?: boolean
}
export type OccupiedRunBinding = {
  workspaceId?: string
  jobId?: string
  provider?: string
  targetKind?: string
  projectId?: string
  projectPath?: string
  chatId?: string
  turnId?: string
}
export function occupiedRunCanNavigate(owner: OccupiedRunOwner | null | undefined, currentBinding: OccupiedRunBinding | null | undefined): boolean
export function occupiedRunCanHandoff(owner: OccupiedRunOwner | null | undefined, entry: QueuedPrompt | null | undefined, currentBinding: OccupiedRunBinding | null | undefined): boolean
export function queueMayAdvanceAfterRun(input: {
  completedSuccessfully?: boolean
  stopAndSendArmed?: boolean
}): boolean
export function liveSteerWasSafelyRejected(error: unknown): boolean
export function queuedPromptGate(chat: Pick<Chat, 'messages'> | undefined, entry: QueuedPrompt | undefined): {
  state: 'empty' | 'ready' | 'waiting' | 'paused'
  reason: string | null
}
export function promptQueueStatusPresentation(
  gate: ReturnType<typeof queuedPromptGate>,
  count: number,
  delivery?: {
    liveDeliverySupported: boolean
    activeProviderName: string | null
    stopAndSendAvailable?: boolean
  },
): {
  headline: string
  detail: string
  actionLabel: string | null
}
export function transcriptMessagesBeforeTurn(messages: Message[], turnId: string): Message[]
export function insertAgentReplyBeforeLaterQueued(messages: Message[], turnId: string, reply: Message): Message[]
export function promoteQueuedMessageToActiveTurn(messages: Message[], messageId: string, activeTurnId: string): Message[]
export function liveSteerReadyAfterEvent(
  current: boolean | undefined,
  event: { type?: string; code?: string | null } | undefined,
): boolean
export function promptSubmissionMode(input: { hasActiveRun: boolean }): 'queue' | 'run'
export function promptQueueComposerState(input: { sending: boolean; draft: string; canRun: boolean; liveSteering?: boolean }): {
  sendEnabled: boolean
  sendLabel: string
  sendText?: string | null
  stopVisible: boolean
  hint: string
}

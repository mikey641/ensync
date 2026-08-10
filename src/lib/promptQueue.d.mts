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
export function liveSteerWasSafelyRejected(error: unknown): boolean
export function queuedPromptGate(chat: Pick<Chat, 'messages'> | undefined, entry: QueuedPrompt | undefined): {
  state: 'empty' | 'ready' | 'waiting' | 'paused'
  reason: string | null
}
export function promptQueueStatusPresentation(
  gate: ReturnType<typeof queuedPromptGate>,
  count: number,
): {
  headline: string
  detail: string
  actionLabel: string | null
}
export function transcriptMessagesBeforeTurn(messages: Message[], turnId: string): Message[]
export function insertAgentReplyBeforeLaterQueued(messages: Message[], turnId: string, reply: Message): Message[]
export function promoteQueuedMessageToActiveTurn(messages: Message[], messageId: string, activeTurnId: string): Message[]
export function promptSubmissionMode(input: { hasActiveRun: boolean }): 'queue' | 'run'
export function promptQueueComposerState(input: { sending: boolean; draft: string; canRun: boolean }): {
  sendEnabled: boolean
  sendLabel: string
  sendText: string | null
  stopVisible: boolean
  hint: string
}

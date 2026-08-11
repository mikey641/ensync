import type { Chat, FileAttachment, ProviderId } from '../types'
import type { PromptQueues, QueuedPrompt } from './promptQueue.mjs'

export type OccupiedRun = {
  ownerJobId: string
  turnId: string | null
  provider: string
  targetKind: 'local' | 'ssh'
  startedAt: string
  providerProcessStarted: boolean
  steerable: boolean
  nativeWorkspaceId: string | null
  projectId: string
  projectPath: string
  chatId: string
  controllable: boolean
}

export type OccupiedRuns = Record<string, OccupiedRun>

export function normalizeOccupiedRuns(value: unknown): OccupiedRuns
export function occupiedQueueSnapshotForAttempt(
  queuedPrompt: QueuedPrompt | null | undefined,
  directSnapshot: {
    queueId?: string
    messageId: string
    enqueuedAt: string
    preferences: QueuedPrompt['preferences']
  },
): {
  queueId?: string
  messageId: string
  enqueuedAt: string
  preferences: QueuedPrompt['preferences']
}

type InFlightLike = Record<string, {
  turnId?: string
  jobId?: string
  projectId?: string
  projectPath?: string
  executionTarget?: string
}>

export function convertPendingTurnToOccupiedQueue(input: {
  chats: Chat[]
  queues: PromptQueues
  inFlightRuns: InFlightLike
  occupiedRuns: OccupiedRuns
  chatId: string
  queueId?: string
  turnId: string
  messageId: string
  prompt: string
  attachments: FileAttachment[]
  enqueuedAt: string
  preferences: QueuedPrompt['preferences']
  owner: {
    jobId?: string | null
    ownerJobId?: string | null
    turnId?: string | null
    provider?: string | null
    targetKind?: 'local' | 'ssh' | null
    startedAt?: string | null
    providerProcessStarted?: boolean
    steerable?: boolean
    nativeWorkspaceId?: string | null
  }
  binding: { projectId: string; projectPath: string; chatId: string }
}): {
  status: 'converted' | 'duplicate' | 'invalid'
  chats: Chat[]
  queues: PromptQueues
  inFlightRuns: InFlightLike
  occupiedRuns: OccupiedRuns
}

export function occupiedRunControls(
  owner: OccupiedRun | null | undefined,
  entry: QueuedPrompt | null | undefined,
  binding: {
    workspaceId?: string | null
    jobId?: string
    turnId?: string
    provider?: string
    targetKind?: string
    projectId?: string
    projectPath?: string
    chatId?: string
  } | null | undefined,
  options?: { nativeAvailable?: boolean; shellReachable?: boolean },
): { canView: boolean; canPush: boolean; canStopAndSend: boolean; reason: string | null }

export function handoffEntryForAction(
  entry: QueuedPrompt,
  stopAndSend: boolean,
  approvedAt: string,
): QueuedPrompt | null

export function commitHandoffAcceptance(
  accepted: { status: string; chats: Chat[]; queues: PromptQueues },
  persist: (state: { chats: Chat[]; promptQueues: PromptQueues }) => boolean,
  apply: (accepted: { status: string; chats: Chat[]; queues: PromptQueues }) => void,
): boolean

export function applyOccupiedJobObservation(
  occupiedRuns: OccupiedRuns,
  chatId: string,
  observation: {
    kind: 'running'; providerProcessStarted: boolean; steerable: boolean
  } | { kind: 'terminal' | 'unavailable' },
): OccupiedRuns

export type NativeExactRunBinding = {
  workspaceId: string
  projectId: string
  projectPath: string
  chatId: string
  jobId: string
}

export function activeNativeRunBindings(inFlightRuns: InFlightLike, workspaceId: string | null | undefined): NativeExactRunBinding[]
export function exactNativeFocusCanApply(request: NativeExactRunBinding | null | undefined, current: NativeExactRunBinding | null | undefined): boolean
export type CompletedNativeRunBinding = NativeExactRunBinding & {
  turnId: string
  provider: ProviderId
  executionTarget: string
}
export function completedNativeRunBinding(
  workspaceId: string | null | undefined,
  chatId: string,
  run: {
    jobId?: string
    turnId?: string
    provider?: ProviderId
    executionTarget?: string
    projectId?: string
    projectPath?: string
  } | null | undefined,
): CompletedNativeRunBinding | null
export function reconcileQueuedMessageHandoff(request: {
  handoffId: string
  target: NativeExactRunBinding
  entry: QueuedPrompt
}, context: {
  workspaceId: string
  projectId: string
  projectPath: string
  chatId: string
  chats: Chat[]
  queues: PromptQueues
}): ReturnType<typeof acceptTransferredPrompt>
export function validateTerminalQueuedMessageHandoff(request: {
  handoffId: string
  target: NativeExactRunBinding
  entry: QueuedPrompt
}, context: {
  workspaceId: string
  projectId: string
  projectPath: string
  chatId: string
  completedRun: CompletedNativeRunBinding | null | undefined
}): boolean
export function validateQueuedMessageHandoff(request: {
  handoffId: string
  target: NativeExactRunBinding
  entry: QueuedPrompt
} | null | undefined, context: {
  workspaceId: string | null | undefined
  projectId: string
  projectPath: string
  chatId: string
  activeRun: {
    turnId: string
    jobId?: string
    provider: ProviderId
    executionTarget: string
    projectId?: string
    projectPath?: string
  } | null | undefined
  queue: QueuedPrompt[]
}): boolean

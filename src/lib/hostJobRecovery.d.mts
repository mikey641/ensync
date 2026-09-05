import type { Chat, Message } from '../types'
import type { ChatJobSnapshot, ChatProviderId } from './ensyncHost'
import type { OccupiedRun, OccupiedRuns } from './occupiedRunState.mjs'

export type RunningHostJobCandidate = {
  chatId: string
  turnId: string
  provider: ChatProviderId
  attempt: number
  jobId: string
}

export function runningHostJobCandidates(
  chats: Chat[],
  options?: { maximumTurns?: number; maximumAttempts?: number; excludedChatIds?: string[] },
): RunningHostJobCandidate[]

export function retryableOccupiedJobProbes(
  occupiedRuns: OccupiedRuns,
  missingExactOwnerKeys?: Iterable<string>,
): Array<{
  chatId: string
  owner: OccupiedRun & { turnId: string; targetKind: 'local' }
  ownerKey: string
}>

export type OccupiedJobProbeLease = {
  start(): boolean
  isCurrent(): boolean
  finish(): boolean
}

export function createOccupiedJobProbeCoordinator(): {
  reserve(ownerKey: string): OccupiedJobProbeLease | null
  invalidateAll(): void
}

export function shouldSuppressOccupiedJobProbe(status: unknown): boolean
export function canonicalPredecessorTranscript(messages: Message[], turnId: string): string | null
export function predecessorTranscriptFingerprint(messages: Message[], turnId: string): Promise<string | null>
export function beginRunAfterPredecessorFingerprint<T>(
  fingerprintPromise: PromiseLike<string | null>,
  signal: AbortSignal,
  begin: (fingerprint: string | null) => T | Promise<T>,
): Promise<T>

export function adoptReconnectableHostJobState<T extends {
  chats: Chat[]
  chatErrors?: Record<string, string | null>
  chatExecutionEvents?: Record<string, unknown[]>
  inFlightRuns?: Record<string, unknown>
}>(state: T, recovery: {
  candidate: RunningHostJobCandidate
  job: ChatJobSnapshot
  projectPath: string
  executionTarget: string
  predecessorTranscriptFingerprint?: string | null
  occupied?: {
    owner: OccupiedRun
    replacementWorkspaceId: string
  }
}): null | {
  chats: Chat[]
  chatErrors: Record<string, string | null>
  chatExecutionEvents: Record<string, unknown[]>
  inFlightRuns: Record<string, unknown>
  inFlightRun: unknown
}

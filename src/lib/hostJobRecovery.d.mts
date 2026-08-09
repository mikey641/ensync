import type { Chat } from '../types'
import type { ChatJobSnapshot, ChatProviderId } from './relayHost'

export type RunningHostJobCandidate = {
  chatId: string
  turnId: string
  provider: ChatProviderId
  attempt: number
  jobId: string
}

export function runningHostJobCandidates(
  chats: Chat[],
  options?: { maximumTurns?: number; maximumAttempts?: number },
): RunningHostJobCandidate[]

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
}): null | {
  chats: Chat[]
  chatErrors: Record<string, string | null>
  chatExecutionEvents: Record<string, unknown[]>
  inFlightRuns: Record<string, unknown>
  inFlightRun: unknown
}

import type { NativeWorkspaceIdentity } from './nativeWorkspaceIdentity.mjs'

export type RecentProjectRecoverySummary = {
  scannedWorkspaces: number
  addedProjects: number
}

export function recoverRecentProjectHistory<T>(
  currentState: T,
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
  options: {
    identity: NativeWorkspaceIdentity
    retainedWorkspaceIds?: string[]
    legacyStates?: unknown[]
  },
): { state: T; summary: RecentProjectRecoverySummary }

import type { NativeWorkspaceIdentity } from './nativeWorkspaceIdentity.mjs'

export function recoverArchivedProjectHistory<T>(
  currentState: T,
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
  options: {
    identity: NativeWorkspaceIdentity
    retainedWorkspaceIds?: string[]
  },
): {
  state: T
  summary: { scannedWorkspaces: number; recoveredProjects: number; addedChats: number }
}

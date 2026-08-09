import type { NativeWorkspaceIdentity } from './nativeWorkspaceIdentity.mjs'

export function recoverOpenedProjectHistory<T>(
  currentState: T,
  storage: Pick<Storage, 'getItem' | 'key' | 'length'>,
  options: {
    projectLaunch: {
      projectId: string
      projectPath: string
      sourceWorkspace: { id: string; kind: NativeWorkspaceIdentity['kind'] }
    }
  },
): {
  state: T
  summary: { recovered: boolean; addedChats: number }
}

export function recoverFocusedProjectHistory<T, P extends { id: string; path: string }>(
  currentState: T,
  storage: Pick<Storage, 'getItem' | 'key' | 'length'>,
  options: {
    project: P
    currentWorkspace: { id: string; kind: NativeWorkspaceIdentity['kind'] }
  },
): {
  state: T
  summary: { recovered: boolean; addedChats: number }
}

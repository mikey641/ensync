export const WORKSPACE_SNAPSHOT_STORAGE_KEY: string
export const WORKSPACE_SNAPSHOT_STAGING_KEY: string
export const WORKSPACE_SNAPSHOT_BACKUP_KEY: string
export const INTERRUPTION_MESSAGE: string

export type WorkspaceSnapshotKeys = { primary: string; staging: string; backup: string }
export function createWorkspaceSnapshotKeys(storageKeyFor?: (baseKey: string) => string): WorkspaceSnapshotKeys

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readWorkspaceSnapshot<T extends object>(storage: Pick<Storage, 'getItem'>, options?: { keys?: WorkspaceSnapshotKeys }): {
  state: T
  revision: number
  committedAt: string
  source: 'primary' | 'staging' | 'backup'
  recovered: boolean
} | null

export function commitWorkspaceSnapshot<T extends object>(
  storage: StorageLike,
  state: T,
  options?: { now?: () => string; keys?: WorkspaceSnapshotKeys },
): { revision: number; committedAt: string; source: 'primary' | 'staging' }

export function compactWorkspaceSnapshot<T extends object>(
  state: T,
  options?: { maxExecutionEventCharacters?: number },
): Omit<T, 'fallbackProviderOrder'>

export function reconcileInterruptedWorkspaceState<T extends object>(
  state: T,
  options?: { now?: () => string; preserveHostJobs?: boolean },
): { state: T; interruptedChatIds: string[] }

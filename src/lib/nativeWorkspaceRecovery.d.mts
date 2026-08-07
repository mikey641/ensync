import type { WorkspaceRecoverySummary } from './workspaceRecovery.mjs'

export type NativeWorkspaceRecoveryResult =
  | { status: 'unavailable' | 'already_applied' }
  | { status: 'already_present' | 'declined'; summary: WorkspaceRecoverySummary }
  | { status: 'applied'; summary: WorkspaceRecoverySummary; commit: { revision: number; committedAt: string; source: 'primary' | 'staging' } }

export function initializeNativeWorkspaceRecovery(
  target?: unknown,
  options?: { confirmRecovery?: (summary: WorkspaceRecoverySummary) => boolean | Promise<boolean> },
): Promise<NativeWorkspaceRecoveryResult>

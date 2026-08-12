export type WorkspaceOverlap = {
  peerBranch: string
  state: 'detected' | 'cleared'
  source: 'active' | 'unlanded'
  paths: string[]
  totalCount: number
}

export type WorkspaceOverlapEvent = {
  type?: string
  overlap?: WorkspaceOverlap
}

export type WorkspaceOverlapSummary = {
  message: string
  paths: string[]
  remainingCount: number
  peerCount: number
}

export function activeWorkspaceOverlaps(events: readonly WorkspaceOverlapEvent[]): WorkspaceOverlap[]

export function workspaceOverlapSummary(
  overlaps: readonly WorkspaceOverlap[],
  branchTitles?: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): WorkspaceOverlapSummary | null

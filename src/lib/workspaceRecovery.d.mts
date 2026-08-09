export type WorkspaceRecoverySummary = {
  addedProjects: number
  addedChats: number
  addedTabs: number
  reconciledRecoveredRuns: number
}

export function mergeRecoveredWorkspaceState<T extends object>(
  currentState: T,
  recoveredState: Partial<T>,
  options?: { now?: () => string; preserveHostJobs?: boolean },
): {
  state: T
  summary: WorkspaceRecoverySummary
  mappings: {
    projectIdMap: Map<string, string>
    chatIdMap: Map<string, string>
    tabIdMap: Map<string, string>
  }
}

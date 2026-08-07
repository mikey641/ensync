export function selectSplitLayoutSource<T>(
  snapshotLayout: T | undefined,
  legacyStoredLayout: T | undefined,
): T | undefined

export function splitPaneDisplayWeights(
  tabIds: readonly string[],
  paneSizes: Readonly<Record<string, number>> | undefined,
  largestTabId: string | null | undefined,
): Record<string, number>

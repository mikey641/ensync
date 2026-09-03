export function selectSplitLayoutSource<T>(
  snapshotLayout: T | undefined,
  legacyStoredLayout: T | undefined,
): T | undefined

export function splitPaneDisplayWeights(
  tabIds: readonly string[],
  paneSizes: Readonly<Record<string, number>> | undefined,
  largestTabId: string | null | undefined,
): Record<string, number>

export function splitPaneAlignmentTabId(
  viewMode: 'tabs' | 'split',
  activeTabId: string | null | undefined,
  largestTabId: string | null | undefined,
  renderedTabIds: readonly string[],
): string | null

export function largestPaneScrollLeft(measurements: {
  scrollLeft: number
  paneLeft: number
  paneWidth: number
  viewportWidth: number
  scrollWidth: number
  snapPoints?: readonly number[]
}): number

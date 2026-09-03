/** The transactional workspace snapshot is canonical; the old split-only key is migration fallback. */
export function selectSplitLayoutSource(snapshotLayout, legacyStoredLayout) {
  return snapshotLayout ?? legacyStoredLayout
}

/**
 * Applies the temporary "largest pane" presentation without overwriting the
 * user's persisted divider sizes. The selected pane receives two thirds of
 * the flexible width when its siblings have equal weights, while every
 * visible sibling remains mounted and visible.
 */
export function splitPaneDisplayWeights(tabIds, paneSizes, largestTabId) {
  const displayWeights = Object.fromEntries(tabIds.map((tabId) => {
    const weight = paneSizes?.[tabId]
    return [tabId, Number.isFinite(weight) && weight > 0 ? weight : 1]
  }))

  if (!largestTabId
    || tabIds.length < 2
    || !Object.prototype.hasOwnProperty.call(displayWeights, largestTabId)) {
    return displayWeights
  }

  const siblingWeightTotal = tabIds.reduce(
    (total, tabId) => tabId === largestTabId ? total : total + displayWeights[tabId],
    0,
  )
  displayWeights[largestTabId] = Math.max(
    displayWeights[largestTabId],
    siblingWeightTotal * 2,
  )
  return displayWeights
}

/**
 * Chooses the visible pane that the split viewport must keep fully in view.
 * A temporary largest pane keeps priority; otherwise activation aligns the
 * ordinary pane the user selected. Normal-tab mode has no split viewport to
 * adjust.
 */
export function splitPaneAlignmentTabId(viewMode, activeTabId, largestTabId, renderedTabIds) {
  if (viewMode !== 'split') return null
  const rendered = new Set(renderedTabIds)
  if (largestTabId && rendered.has(largestTabId)) return largestTabId
  return activeTabId && rendered.has(activeTabId) ? activeTabId : null
}

/**
 * Horizontal scroll that keeps the selected pane fully visible. Sibling
 * minimum widths can lay a pane out past the viewport's right edge, so without
 * an adjustment its content is clipped. Scrolls the minimum distance while
 * choosing a compatible CSS snap point when one exists: a pane already fully
 * visible keeps the user's scroll position, and a pane wider than the viewport
 * aligns its left edge.
 */
export function largestPaneScrollLeft({
  scrollLeft,
  paneLeft,
  paneWidth,
  viewportWidth,
  scrollWidth,
  snapPoints,
}) {
  if (![scrollLeft, paneLeft, paneWidth, viewportWidth, scrollWidth].every(Number.isFinite)
    || viewportWidth <= 0 || paneWidth <= 0) {
    return scrollLeft
  }

  const clampScroll = (value) =>
    Math.min(Math.max(0, scrollWidth - viewportWidth), Math.max(0, value))
  const paneRight = paneLeft + paneWidth
  const paneIsFullyVisible = paneLeft >= scrollLeft
    && paneRight <= scrollLeft + viewportWidth
  if (paneIsFullyVisible) return scrollLeft

  const target = paneWidth >= viewportWidth || paneLeft < scrollLeft
    ? clampScroll(paneLeft)
    : clampScroll(paneRight - viewportWidth)
  if (paneWidth >= viewportWidth || !Array.isArray(snapPoints)) return target

  const minimumFullyVisibleScroll = paneRight - viewportWidth
  const maximumFullyVisibleScroll = paneLeft
  const compatibleSnapPoints = snapPoints
    .filter(Number.isFinite)
    .map(clampScroll)
    .filter((point) => point >= minimumFullyVisibleScroll
      && point <= maximumFullyVisibleScroll)
  if (compatibleSnapPoints.length === 0) return target

  return compatibleSnapPoints.reduce((closest, point) =>
    Math.abs(point - scrollLeft) < Math.abs(closest - scrollLeft) ? point : closest)
}

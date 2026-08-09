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
 * Horizontal scroll that keeps the temporary largest pane fully visible.
 * Sibling minimum widths lay the enlarged pane out past the viewport's right
 * edge, so without an adjustment its centered conversation content renders
 * half empty and half clipped. Scrolls the minimum distance: a pane already
 * fully visible keeps the user's scroll position, and a pane wider than the
 * viewport aligns its left edge.
 */
export function largestPaneScrollLeft({
  scrollLeft,
  paneLeft,
  paneWidth,
  viewportWidth,
  scrollWidth,
}) {
  if (![scrollLeft, paneLeft, paneWidth, viewportWidth, scrollWidth].every(Number.isFinite)
    || viewportWidth <= 0 || paneWidth <= 0) {
    return scrollLeft
  }

  const clampScroll = (value) =>
    Math.min(Math.max(0, scrollWidth - viewportWidth), Math.max(0, value))
  if (paneWidth >= viewportWidth || paneLeft < scrollLeft) return clampScroll(paneLeft)

  const hiddenOnRight = paneLeft + paneWidth - (scrollLeft + viewportWidth)
  return clampScroll(scrollLeft + Math.max(0, hiddenOnRight))
}

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

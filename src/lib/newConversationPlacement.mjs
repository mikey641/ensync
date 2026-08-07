/**
 * Inserts a new stable workspace tab without mutating the caller's order.
 * Adjacent placement is anchored to the exact header that initiated creation;
 * end placement deliberately ignores that anchor.
 */
export function insertNewConversationTab(tabs, tab, placement, relativeToTabId) {
  const next = [...tabs]
  if (placement !== 'adjacent') {
    next.push(tab)
    return next
  }

  const relativeIndex = tabs.findIndex((candidate) => candidate.id === relativeToTabId)
  if (relativeIndex < 0) {
    next.push(tab)
    return next
  }

  next.splice(relativeIndex + 1, 0, tab)
  return next
}

/**
 * Resolves the active tab after one tab closes. Closing the final open tab
 * deliberately returns an empty identity so the workspace can stay empty.
 */
export function activeTabIdAfterClose(tabs, activeTabId, closingTabId) {
  if (activeTabId !== closingTabId) return activeTabId

  const closingIndex = tabs.findIndex((tab) => tab.id === closingTabId)
  if (closingIndex < 0) return activeTabId

  const remainingTabs = tabs.filter((tab) => tab.id !== closingTabId)
  return remainingTabs[Math.max(0, closingIndex - 1)]?.id ?? ''
}

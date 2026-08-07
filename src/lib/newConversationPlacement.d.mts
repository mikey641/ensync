import type { NewTabPlacement, WorkspaceTab } from '../types'

export function insertNewConversationTab(
  tabs: readonly WorkspaceTab[],
  tab: WorkspaceTab,
  placement: NewTabPlacement,
  relativeToTabId: string | undefined,
): WorkspaceTab[]

export function activeTabIdAfterClose(
  tabs: readonly WorkspaceTab[],
  activeTabId: string,
  closingTabId: string,
): string

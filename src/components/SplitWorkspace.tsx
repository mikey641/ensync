import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Columns3, Eye, EyeOff, GripVertical, MoveHorizontal, Paperclip, Plus, X } from 'lucide-react'
import type { Chat, ConversationLayoutMode, Provider, WorkspaceTab } from '../types'
import type { CompletionIndicatorPreference } from '../display-preferences'
import { fileDragContainsFiles } from '../lib/fileAttachments.mjs'
import {
  selectSplitLayoutSource,
  splitPaneDisplayWeights,
} from '../lib/splitLayoutPersistence.mjs'
import './SplitWorkspace.css'

const DEFAULT_PANE_WEIGHT = 1
const KEYBOARD_RESIZE_STEP = 32
const ENSYNC_SPLIT_STORAGE_KEY = 'ensync-split-layout-v1'
const LEGACY_RELAY_SPLIT_STORAGE_KEY = 'relay-split-layout-v1'

export type SplitWorkspaceLayout = {
  /** Relative pane widths keyed by the stable WorkspaceTab ID. */
  paneSizes: Record<string, number>
  /** Hidden tab IDs. Hiding a pane never removes the tab or conversation. */
  hiddenTabIds: string[]
  /**
   * Legacy snapshot field name retained for compatibility. The identified
   * pane is temporarily the largest while the other panes stay visible.
   */
  maximizedTabId: string | null
}

export type SplitPaneRenderContext = {
  tab: WorkspaceTab
  chat: Chat
  provider?: Provider
  isActive: boolean
  isMaximized: boolean
  activate: () => void
  hide: () => void
  toggleMaximize: () => void
}

export type SplitWorkspaceProps = {
  tabs: WorkspaceTab[]
  chats: Chat[]
  providers?: Provider[]
  /** Tab IDs with an unread completed agent response. */
  completedTabIds?: readonly string[]
  /** Device-local visual treatment for an unread completed response. */
  completionIndicator?: CompletionIndicatorPreference
  activeTabId?: string
  defaultActiveTabId?: string
  defaultLayout?: Partial<SplitWorkspaceLayout>
  /** When supplied, pane widths, visibility, and temporary-largest state persist locally. */
  storageKey?: string
  minPaneWidth?: number
  className?: string
  renderPane: (context: SplitPaneRenderContext) => ReactNode
  onActiveTabChange?: (tabId: string) => void
  /** Reorders stable tab IDs without changing the active conversation or pane layout state. */
  onTabReorder?: (tabId: string, targetTabId: string, position: 'before' | 'after') => void
  onCloseTab?: (tabId: string) => void
  /** Creates a conversation relative to the specific visible tab whose action was used. */
  onNewTab?: (relativeToTabId: string) => void
  /** Adds operating-system file drops to the exact conversation under the pointer. */
  onFilesDrop?: (chatId: string, files: FileList) => void
  /** Controls the pointer feedback without pretending unsupported drops can be attached. */
  fileDropAvailable?: boolean
  /** Explains why a recognized file drop is unavailable for the current target or surface. */
  fileDropUnavailableMessage?: string
  /** Normal tabs show one active conversation; split shows every visible pane side by side. */
  viewMode?: ConversationLayoutMode
  /** Hides only pane tab headers; conversations and pane geometry remain mounted. */
  showTabHeaders?: boolean
  onLayoutChange?: (layout: SplitWorkspaceLayout) => void
  emptyState?: ReactNode
}

type ResizeDragState = {
  pointerId: number
  startX: number
  leftTabId: string
  rightTabId: string
  leftWidth: number
  rightWidth: number
  pairWeight: number
}

type TabDragState = {
  tabId: string
  overTabId: string | null
  position: 'before' | 'after' | null
}

function CompletionStatus({
  title,
  indicator,
}: {
  title: string
  indicator: CompletionIndicatorPreference
}) {
  return (
    <span
      className={indicator === 'dot' ? 'relay-split-completed-dot' : 'relay-split-completed-status'}
      role="status"
      aria-label={`${title} finished working`}
      title="Finished working"
    />
  )
}

function getStoredLayout(storageKey?: string): Partial<SplitWorkspaceLayout> | undefined {
  if (!storageKey || typeof window === 'undefined') return undefined

  try {
    const value = window.localStorage.getItem(storageKey)
      ?? (storageKey === ENSYNC_SPLIT_STORAGE_KEY
        ? window.localStorage.getItem(LEGACY_RELAY_SPLIT_STORAGE_KEY)
        : null)
    return value ? (JSON.parse(value) as Partial<SplitWorkspaceLayout>) : undefined
  } catch {
    return undefined
  }
}

function createInitialLayout(
  tabs: WorkspaceTab[],
  defaultLayout?: Partial<SplitWorkspaceLayout>,
  storageKey?: string,
): SplitWorkspaceLayout {
  const stored = getStoredLayout(storageKey)
  const source = selectSplitLayoutSource(defaultLayout, stored)

  return {
    paneSizes: Object.fromEntries(
      tabs.map((tab) => {
        const size = source?.paneSizes?.[tab.id]
        return [tab.id, typeof size === 'number' && size > 0 ? size : DEFAULT_PANE_WEIGHT]
      }),
    ),
    hiddenTabIds: source?.hiddenTabIds?.filter((id) => tabs.some((tab) => tab.id === id)) ?? [],
    maximizedTabId: tabs.some((tab) => tab.id === source?.maximizedTabId)
      ? source?.maximizedTabId ?? null
      : null,
  }
}

function layoutsMatch(left: SplitWorkspaceLayout, right: SplitWorkspaceLayout) {
  if (left.maximizedTabId !== right.maximizedTabId) return false
  if (left.hiddenTabIds.length !== right.hiddenTabIds.length) return false
  if (left.hiddenTabIds.some((id, index) => id !== right.hiddenTabIds[index])) return false

  const leftKeys = Object.keys(left.paneSizes)
  const rightKeys = Object.keys(right.paneSizes)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left.paneSizes[key] === right.paneSizes[key])
}

/**
 * Owns the mutable presentation state for split panes while preserving the
 * caller's tab and conversation IDs.
 */
export function useSplitWorkspaceLayout({
  tabs,
  defaultLayout,
  storageKey,
  onLayoutChange,
}: Pick<SplitWorkspaceProps, 'tabs' | 'defaultLayout' | 'storageKey' | 'onLayoutChange'>) {
  const [layout, setLayout] = useState<SplitWorkspaceLayout>(() =>
    createInitialLayout(tabs, defaultLayout, storageKey),
  )

  useEffect(() => {
    const tabIds = new Set(tabs.map((tab) => tab.id))
    setLayout((current) => {
      const next: SplitWorkspaceLayout = {
        paneSizes: Object.fromEntries(
          tabs.map((tab) => [tab.id, current.paneSizes[tab.id] ?? DEFAULT_PANE_WEIGHT]),
        ),
        hiddenTabIds: current.hiddenTabIds.filter((id) => tabIds.has(id)),
        maximizedTabId: current.maximizedTabId && tabIds.has(current.maximizedTabId)
          ? current.maximizedTabId
          : null,
      }
      return layoutsMatch(current, next) ? current : next
    })
  }, [tabs])

  useLayoutEffect(() => {
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(layout))
      } catch {
        // Storage can be unavailable in private or restricted browser contexts.
      }
    }
    onLayoutChange?.(layout)
  }, [layout, onLayoutChange, storageKey])

  const hidePane = useCallback((tabId: string) => {
    setLayout((current) => current.hiddenTabIds.includes(tabId)
      ? current
      : {
          ...current,
          hiddenTabIds: [...current.hiddenTabIds, tabId],
          maximizedTabId: current.maximizedTabId === tabId ? null : current.maximizedTabId,
        })
  }, [])

  const showPane = useCallback((tabId: string) => {
    setLayout((current) => ({
      ...current,
      hiddenTabIds: current.hiddenTabIds.filter((id) => id !== tabId),
    }))
  }, [])

  const showAllPanes = useCallback(() => {
    setLayout((current) => current.hiddenTabIds.length === 0
      ? current
      : { ...current, hiddenTabIds: [] })
  }, [])

  const toggleLargestPane = useCallback((tabId: string) => {
    setLayout((current) => ({
      ...current,
      hiddenTabIds: current.hiddenTabIds.filter((id) => id !== tabId),
      maximizedTabId: current.maximizedTabId === tabId ? null : tabId,
    }))
  }, [])

  const restorePaneSizes = useCallback(() => {
    setLayout((current) => current.maximizedTabId === null
      ? current
      : { ...current, maximizedTabId: null })
  }, [])

  const setPanePairSizes = useCallback((
    leftTabId: string,
    rightTabId: string,
    leftSize: number,
    rightSize: number,
  ) => {
    if (leftSize <= 0 || rightSize <= 0) return
    setLayout((current) => ({
      ...current,
      // A manual divider adjustment becomes the new explicit layout and
      // therefore exits the temporary largest-pane presentation.
      maximizedTabId: null,
      paneSizes: {
        ...current.paneSizes,
        [leftTabId]: leftSize,
        [rightTabId]: rightSize,
      },
    }))
  }, [])

  return {
    layout,
    setLayout,
    hidePane,
    showPane,
    showAllPanes,
    toggleLargestPane,
    restorePaneSizes,
    setPanePairSizes,
  }
}

export function SplitWorkspace({
  tabs,
  chats,
  providers = [],
  completedTabIds = [],
  completionIndicator = 'dot',
  activeTabId,
  defaultActiveTabId,
  defaultLayout,
  storageKey,
  minPaneWidth = 300,
  className = '',
  renderPane,
  onActiveTabChange,
  onTabReorder,
  onCloseTab,
  onNewTab,
  onFilesDrop,
  fileDropAvailable = false,
  fileDropUnavailableMessage = 'Local file drops are unavailable here',
  viewMode = 'split',
  showTabHeaders = true,
  onLayoutChange,
  emptyState,
}: SplitWorkspaceProps) {
  const [internalActiveTabId, setInternalActiveTabId] = useState(
    defaultActiveTabId ?? tabs[0]?.id ?? '',
  )
  const [resizeDragState, setResizeDragState] = useState<ResizeDragState | null>(null)
  const [tabDragState, setTabDragState] = useState<TabDragState | null>(null)
  const [fileDragTabId, setFileDragTabId] = useState<string | null>(null)
  const fileDragDepthRef = useRef(new Map<string, number>())
  const [reorderAnnouncement, setReorderAnnouncement] = useState('')
  const blockTabDragRef = useRef(false)
  const suppressMaximizeAfterDragRef = useRef(false)
  const dragSuppressionTimerRef = useRef<number | null>(null)
  const {
    layout,
    hidePane,
    showPane,
    showAllPanes,
    toggleLargestPane,
    restorePaneSizes,
    setPanePairSizes,
  } = useSplitWorkspaceLayout({ tabs, defaultLayout, storageKey, onLayoutChange })

  const chatById = useMemo(() => new Map(chats.map((chat) => [chat.id, chat])), [chats])
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  )
  const hiddenIdSet = useMemo(() => new Set(layout.hiddenTabIds), [layout.hiddenTabIds])
  const completedIdSet = useMemo(() => new Set(completedTabIds), [completedTabIds])
  const workspaceTabs = tabs.filter((tab) => chatById.has(tab.chatId))
  const hiddenTabs = viewMode === 'split'
    ? workspaceTabs.filter((tab) => hiddenIdSet.has(tab.id))
    : []
  const visibleTabs = viewMode === 'split'
    ? workspaceTabs.filter((tab) => !hiddenIdSet.has(tab.id))
    : workspaceTabs
  const resolvedActiveTabId = activeTabId ?? internalActiveTabId
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === resolvedActiveTabId)
    ?? workspaceTabs[0]
  const activeWorkspaceTabIsVisible = Boolean(
    activeWorkspaceTab
    && (viewMode === 'tabs' || !hiddenIdSet.has(activeWorkspaceTab.id)),
  )
  const renderedTabs = viewMode === 'tabs'
    ? activeWorkspaceTab ? [activeWorkspaceTab] : []
    : visibleTabs
  const renderedPaneWeights = splitPaneDisplayWeights(
    renderedTabs.map((tab) => tab.id),
    layout.paneSizes,
    viewMode === 'split' ? layout.maximizedTabId : null,
  )
  const renderedWeightTotal = renderedTabs.reduce(
    (total, tab) => total + renderedPaneWeights[tab.id],
    0,
  )
  // CSS flex-grow deliberately leaves unused space when all grow factors add
  // up to less than one. That can happen after a resized sibling is hidden.
  // Scaling the remaining relative weights keeps the visible panes edge-to-edge.
  const renderedWeightScale = renderedWeightTotal > 0 && renderedWeightTotal < 1
    ? 1 / renderedWeightTotal
    : 1
  const activateTab = useCallback((tabId: string) => {
    setInternalActiveTabId(tabId)
    onActiveTabChange?.(tabId)
  }, [onActiveTabChange])

  const finishTabDrag = useCallback(() => {
    suppressMaximizeAfterDragRef.current = true
    if (dragSuppressionTimerRef.current !== null) {
      window.clearTimeout(dragSuppressionTimerRef.current)
    }
    dragSuppressionTimerRef.current = window.setTimeout(() => {
      suppressMaximizeAfterDragRef.current = false
      dragSuppressionTimerRef.current = null
    }, 300)
    setTabDragState(null)
  }, [])

  const finishFileDrag = useCallback((tabId?: string) => {
    if (tabId) fileDragDepthRef.current.delete(tabId)
    else fileDragDepthRef.current.clear()
    setFileDragTabId((current) => !tabId || current === tabId ? null : current)
  }, [])

  useEffect(() => () => {
    if (dragSuppressionTimerRef.current !== null) {
      window.clearTimeout(dragSuppressionTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const finish = () => finishFileDrag()
    window.addEventListener('dragend', finish)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('dragend', finish)
      window.removeEventListener('blur', finish)
    }
  }, [finishFileDrag])

  useEffect(() => {
    if (tabs.length === 0) return
    const activeExists = workspaceTabs.some((tab) => tab.id === resolvedActiveTabId)
    const activeIsVisible = viewMode === 'tabs' || !hiddenIdSet.has(resolvedActiveTabId)
    if (!activeExists || !activeIsVisible) {
      activateTab(visibleTabs[0]?.id ?? workspaceTabs[0]?.id ?? tabs[0].id)
    }
  }, [activateTab, hiddenIdSet, resolvedActiveTabId, tabs, viewMode, visibleTabs, workspaceTabs])

  useEffect(() => {
    if (activeWorkspaceTabIsVisible && activeWorkspaceTab) {
      onActiveTabChange?.(activeWorkspaceTab.id)
    }
  }, [activeWorkspaceTab, activeWorkspaceTabIsVisible, onActiveTabChange])

  useEffect(() => {
    if (!resizeDragState) return undefined

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== resizeDragState.pointerId) return
      const pairWidth = resizeDragState.leftWidth + resizeDragState.rightWidth
      const minWidth = Math.min(minPaneWidth, pairWidth / 2)
      const nextLeftWidth = Math.min(
        pairWidth - minWidth,
        Math.max(minWidth, resizeDragState.leftWidth + event.clientX - resizeDragState.startX),
      )
      const leftWeight = (nextLeftWidth / pairWidth) * resizeDragState.pairWeight
      setPanePairSizes(
        resizeDragState.leftTabId,
        resizeDragState.rightTabId,
        leftWeight,
        resizeDragState.pairWeight - leftWeight,
      )
    }

    const finishDrag = (event: PointerEvent) => {
      if (event.pointerId === resizeDragState.pointerId) setResizeDragState(null)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
    }
  }, [resizeDragState, minPaneWidth, setPanePairSizes])

  useEffect(() => {
    if (!tabDragState) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishTabDrag()
    }

    window.addEventListener('dragend', finishTabDrag)
    window.addEventListener('drop', finishTabDrag)
    window.addEventListener('blur', finishTabDrag)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('dragend', finishTabDrag)
      window.removeEventListener('drop', finishTabDrag)
      window.removeEventListener('blur', finishTabDrag)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [finishTabDrag, tabDragState])

  useEffect(() => {
    if (!tabDragState) return
    const tabIds = new Set(tabs.map((tab) => tab.id))
    if (!tabIds.has(tabDragState.tabId)
      || (tabDragState.overTabId && !tabIds.has(tabDragState.overTabId))) {
      setTabDragState(null)
    }
  }, [tabDragState, tabs])

  const beginResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    leftTabId: string,
    rightTabId: string,
  ) => {
    if (event.button !== 0) return
    const divider = event.currentTarget
    const leftPane = divider.previousElementSibling as HTMLElement | null
    const rightPane = divider.nextElementSibling as HTMLElement | null
    if (!leftPane || !rightPane) return

    event.preventDefault()
    setResizeDragState({
      pointerId: event.pointerId,
      startX: event.clientX,
      leftTabId,
      rightTabId,
      leftWidth: leftPane.getBoundingClientRect().width,
      rightWidth: rightPane.getBoundingClientRect().width,
      pairWeight: (layout.paneSizes[leftTabId] ?? DEFAULT_PANE_WEIGHT)
        + (layout.paneSizes[rightTabId] ?? DEFAULT_PANE_WEIGHT),
    })
  }

  const beginTabDrag = (event: ReactDragEvent<HTMLDivElement>, tabId: string) => {
    if (!onTabReorder || tabs.length < 2 || blockTabDragRef.current) {
      event.preventDefault()
      blockTabDragRef.current = false
      return
    }

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', tabId)
    setTabDragState({ tabId, overTabId: null, position: null })
  }

  const beginFileDrag = (event: ReactDragEvent<HTMLElement>, tabId: string) => {
    if (!onFilesDrop || !fileDragContainsFiles(event.dataTransfer)) return false
    event.preventDefault()
    event.stopPropagation()
    for (const currentTabId of fileDragDepthRef.current.keys()) {
      if (currentTabId !== tabId) fileDragDepthRef.current.delete(currentTabId)
    }
    fileDragDepthRef.current.set(tabId, (fileDragDepthRef.current.get(tabId) ?? 0) + 1)
    setFileDragTabId(tabId)
    return true
  }

  const continueFileDrag = (event: ReactDragEvent<HTMLElement>, tabId: string) => {
    if (!onFilesDrop || !fileDragContainsFiles(event.dataTransfer)) return false
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = fileDropAvailable ? 'copy' : 'none'
    setFileDragTabId(tabId)
    return true
  }

  const leaveFileDrag = (event: ReactDragEvent<HTMLElement>, tabId: string) => {
    if (!onFilesDrop || !fileDragContainsFiles(event.dataTransfer)) return false
    event.preventDefault()
    event.stopPropagation()
    const depth = Math.max(0, (fileDragDepthRef.current.get(tabId) ?? 1) - 1)
    if (depth > 0) fileDragDepthRef.current.set(tabId, depth)
    else finishFileDrag(tabId)
    return true
  }

  const dropFiles = (
    event: ReactDragEvent<HTMLElement>,
    tabId: string,
    chatId: string,
  ) => {
    if (!onFilesDrop || !fileDragContainsFiles(event.dataTransfer)) return false
    event.preventDefault()
    event.stopPropagation()
    finishFileDrag()
    activateTab(tabId)
    onFilesDrop(chatId, event.dataTransfer.files)
    return true
  }

  const updateTabDropTarget = (event: ReactDragEvent<HTMLDivElement>, targetTabId: string) => {
    if (continueFileDrag(event, targetTabId)) return
    if (!tabDragState || tabDragState.tabId === targetTabId || !onTabReorder) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after'
    setTabDragState((current) => current
      && (current.overTabId !== targetTabId || current.position !== position)
      ? { ...current, overTabId: targetTabId, position }
      : current)
  }

  const leaveTabDropTarget = (event: ReactDragEvent<HTMLDivElement>, targetTabId: string) => {
    if (leaveFileDrag(event, targetTabId)) return
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return
    setTabDragState((current) => current?.overTabId === targetTabId
      ? { ...current, overTabId: null, position: null }
      : current)
  }

  const dropTab = (event: ReactDragEvent<HTMLDivElement>, targetTabId: string) => {
    const targetChatId = tabs.find((tab) => tab.id === targetTabId)?.chatId
    if (targetChatId && dropFiles(event, targetTabId, targetChatId)) return
    event.preventDefault()
    const sourceTabId = tabDragState?.tabId || event.dataTransfer.getData('text/plain')
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = tabDragState?.overTabId === targetTabId && tabDragState.position
      ? tabDragState.position
      : event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after'
    finishTabDrag()
    if (!sourceTabId || sourceTabId === targetTabId || !tabs.some((tab) => tab.id === sourceTabId)) return
    onTabReorder?.(sourceTabId, targetTabId, position)
    const sourceTitle = chatById.get(tabs.find((tab) => tab.id === sourceTabId)?.chatId ?? '')?.title
      ?? 'Conversation'
    const targetTitle = chatById.get(tabs.find((tab) => tab.id === targetTabId)?.chatId ?? '')?.title
      ?? 'conversation'
    setReorderAnnouncement(`Moved ${sourceTitle} ${position} ${targetTitle}.`)
  }

  const keyboardReorder = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tabId: string,
  ) => {
    if (!onTabReorder || !event.altKey || !event.shiftKey
      || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    const index = visibleTabs.findIndex((tab) => tab.id === tabId)
    const target = visibleTabs[event.key === 'ArrowLeft' ? index - 1 : index + 1]
    if (!target) return

    event.preventDefault()
    event.stopPropagation()
    const position = event.key === 'ArrowLeft' ? 'before' : 'after'
    onTabReorder(tabId, target.id, position)
    const sourceTitle = chatById.get(tabs.find((tab) => tab.id === tabId)?.chatId ?? '')?.title
      ?? 'Conversation'
    const direction = event.key === 'ArrowLeft' ? 'left' : 'right'
    setReorderAnnouncement(`Moved ${sourceTitle} one position ${direction}.`)
  }

  const keyboardResize = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    leftTabId: string,
    rightTabId: string,
  ) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const divider = event.currentTarget
    const leftPane = divider.previousElementSibling as HTMLElement | null
    const rightPane = divider.nextElementSibling as HTMLElement | null
    if (!leftPane || !rightPane) return

    event.preventDefault()
    const leftWidth = leftPane.getBoundingClientRect().width
    const rightWidth = rightPane.getBoundingClientRect().width
    const pairWidth = leftWidth + rightWidth
    const minWidth = Math.min(minPaneWidth, pairWidth / 2)
    const delta = event.key === 'ArrowRight' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP
    const nextLeftWidth = Math.min(pairWidth - minWidth, Math.max(minWidth, leftWidth + delta))
    const pairWeight = (layout.paneSizes[leftTabId] ?? DEFAULT_PANE_WEIGHT)
      + (layout.paneSizes[rightTabId] ?? DEFAULT_PANE_WEIGHT)
    const nextLeftWeight = (nextLeftWidth / pairWidth) * pairWeight
    setPanePairSizes(leftTabId, rightTabId, nextLeftWeight, pairWeight - nextLeftWeight)
  }

  const hideTab = (tabId: string) => {
    hidePane(tabId)
    const nextTab = visibleTabs.find((tab) => tab.id !== tabId)
    if (resolvedActiveTabId === tabId && nextTab) activateTab(nextTab.id)
  }

  const rootStyle = {
    '--relay-split-min-pane': `${minPaneWidth}px`,
    '--relay-split-min-total': `${Math.max(
      minPaneWidth,
      renderedTabs.length * minPaneWidth + Math.max(0, renderedTabs.length - 1) * 8,
    )}px`,
  } as CSSProperties

  return (
    <section
      className={`relay-split-workspace relay-split-workspace--${viewMode} ${resizeDragState ? 'relay-split-workspace--resizing' : ''} ${tabDragState ? 'relay-split-workspace--reordering' : ''} ${className}`.trim()}
      style={rootStyle}
      data-completion-indicator={completionIndicator}
      aria-label={viewMode === 'split' ? 'Conversation split workspace' : 'Conversation tab workspace'}
    >
      <span className="relay-split-announcement" role="status" aria-live="polite">
        {reorderAnnouncement}
      </span>
      {viewMode === 'tabs' && showTabHeaders && (
        <div className="relay-tabs-mode-bar" role="tablist" aria-label="Open conversations">
          <div className="relay-tabs-mode-list">
            {workspaceTabs.map((tab) => {
              const chat = chatById.get(tab.chatId)
              if (!chat) return null
              const isActive = resolvedActiveTabId === tab.id
              const isCompleted = completedIdSet.has(tab.id)
              return (
                <div
                  key={tab.id}
                  className={`relay-tabs-mode-tab ${isActive ? 'relay-tabs-mode-tab--active' : ''} ${isCompleted ? 'relay-tabs-mode-tab--completed' : ''} ${tabDragState?.tabId === tab.id ? 'relay-tabs-mode-tab--dragging' : ''} ${fileDragTabId === tab.id ? 'relay-tabs-mode-tab--file-drag' : ''} ${tabDragState?.overTabId === tab.id && tabDragState.position ? `relay-tabs-mode-tab--drop-${tabDragState.position}` : ''}`}
                  draggable={Boolean(onTabReorder && workspaceTabs.length > 1)}
                  onPointerDownCapture={(event) => {
                    blockTabDragRef.current = Boolean(
                      (event.target as Element).closest('.relay-tabs-mode-tab-actions'),
                    )
                  }}
                  onPointerUp={() => { blockTabDragRef.current = false }}
                  onDragStart={(event) => beginTabDrag(event, tab.id)}
                  onDragEnter={(event) => { beginFileDrag(event, tab.id) }}
                  onDragOver={(event) => updateTabDropTarget(event, tab.id)}
                  onDragLeave={(event) => leaveTabDropTarget(event, tab.id)}
                  onDrop={(event) => dropTab(event, tab.id)}
                  onDragEnd={finishTabDrag}
                >
                  <button
                    className="relay-tabs-mode-activate"
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => activateTab(tab.id)}
                    onKeyDown={(event) => keyboardReorder(event, tab.id)}
                    aria-keyshortcuts={onTabReorder ? 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight' : undefined}
                    title={onTabReorder && workspaceTabs.length > 1 ? `${chat.title}. Drag to reorder.` : chat.title}
                  >
                    <span className="relay-split-pane-title" dir="auto">{chat.title}</span>
                    {isCompleted && <CompletionStatus title={chat.title} indicator={completionIndicator} />}
                  </button>
                  {(onNewTab || onCloseTab) && (
                    <span className="relay-tabs-mode-tab-actions" draggable={false}>
                      {onNewTab && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            onNewTab(tab.id)
                          }}
                          aria-label={`New conversation from ${chat.title}`}
                          title="New conversation (Cmd/Ctrl+T)"
                        >
                          <Plus size={14} />
                        </button>
                      )}
                      {onCloseTab && (
                        <button type="button" onClick={() => onCloseTab(tab.id)} aria-label={`Close ${chat.title}`} title="Close tab"><X size={14} /></button>
                      )}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {viewMode === 'split' && hiddenTabs.length > 0 && (
        <div className="relay-split-hidden-bar" role="toolbar" aria-label="Hidden conversation panes">
          <span><EyeOff size={15} /> Hidden</span>
          <div className="relay-split-hidden-list">
            {hiddenTabs.map((tab) => {
              const chat = chatById.get(tab.chatId)
              const isCompleted = completedIdSet.has(tab.id)
              return (
                <button
                  key={tab.id}
                  className={isCompleted ? 'relay-split-hidden-tab--completed' : undefined}
                  type="button"
                  onClick={() => {
                    showPane(tab.id)
                    restorePaneSizes()
                    activateTab(tab.id)
                  }}
                  title={`Show ${chat?.title ?? 'conversation'}`}
                >
                  <Eye size={14} />
                  {isCompleted && (
                    <CompletionStatus
                      title={chat?.title ?? 'Conversation'}
                      indicator={completionIndicator}
                    />
                  )}
                  <span>{chat?.title ?? 'Conversation'}</span>
                </button>
              )
            })}
          </div>
          {hiddenTabs.length > 1 && (
            <button className="relay-split-show-all" type="button" onClick={showAllPanes}>
              Show all
            </button>
          )}
        </div>
      )}

      {renderedTabs.length === 0 ? (
        <div className="relay-split-empty">
          {emptyState ?? (
            <>
              <p>No conversation panes are visible.</p>
              {hiddenTabs.length > 0 && <button type="button" onClick={showAllPanes}>Show all panes</button>}
            </>
          )}
        </div>
      ) : (
        <div className="relay-split-viewport">
          <div className={`relay-split-panes ${viewMode === 'tabs' ? 'relay-split-panes--tabs' : ''}`}>
            {renderedTabs.map((tab, index) => {
              const chat = chatById.get(tab.chatId)
              if (!chat) return null
              const provider = providerById.get(chat.provider)
              const isActive = resolvedActiveTabId === tab.id
              const isMaximized = viewMode === 'split' && layout.maximizedTabId === tab.id
              const isCompleted = completedIdSet.has(tab.id)
              const nextTab = renderedTabs[index + 1]
              const paneStyle = {
                '--relay-split-pane-weight': (
                  renderedPaneWeights[tab.id] ?? DEFAULT_PANE_WEIGHT
                ) * renderedWeightScale,
              } as CSSProperties

              return (
                <Fragment key={tab.id}>
                  <article
                    className={`relay-split-pane ${viewMode === 'tabs' ? 'relay-split-pane--tabs' : ''} ${isMaximized ? 'relay-split-pane--largest' : ''} ${isActive ? 'relay-split-pane--active' : ''} ${isCompleted ? 'relay-split-pane--completed' : ''} ${tabDragState?.tabId === tab.id ? 'relay-split-pane--dragging' : ''} ${fileDragTabId === tab.id ? 'relay-split-pane--file-drag' : ''}`}
                    style={paneStyle}
                    data-tab-id={tab.id}
                    aria-label={`${chat.title} conversation pane`}
                    onDragEnterCapture={(event) => { beginFileDrag(event, tab.id) }}
                    onDragOverCapture={(event) => { continueFileDrag(event, tab.id) }}
                    onDragLeaveCapture={(event) => { leaveFileDrag(event, tab.id) }}
                    onDropCapture={(event) => { dropFiles(event, tab.id, chat.id) }}
                  >
                    {fileDragTabId === tab.id && (
                      <div className="relay-split-file-drop-overlay" aria-hidden="true">
                        <Paperclip size={24} />
                        <strong>{fileDropAvailable ? 'Drop files to attach' : fileDropUnavailableMessage}</strong>
                      </div>
                    )}
                    {viewMode === 'split' && showTabHeaders && (
                      <div
                        className={`relay-split-pane-tab ${tabDragState?.overTabId === tab.id && tabDragState.position ? `relay-split-pane-tab--drop-${tabDragState.position}` : ''}`}
                        title={onTabReorder && tabs.length > 1
                          ? `${isMaximized ? 'Double-click to restore pane sizes' : 'Double-click to make pane largest'}. Drag to reorder.`
                          : isMaximized ? 'Double-click to restore pane sizes' : 'Double-click to make pane largest'}
                        draggable={Boolean(onTabReorder && tabs.length > 1)}
                        onPointerDownCapture={(event) => {
                          blockTabDragRef.current = Boolean(
                            (event.target as Element).closest('.relay-split-pane-actions'),
                          )
                        }}
                        onPointerUp={() => { blockTabDragRef.current = false }}
                        onDragStart={(event) => beginTabDrag(event, tab.id)}
                        onDragOver={(event) => updateTabDropTarget(event, tab.id)}
                        onDragLeave={(event) => leaveTabDropTarget(event, tab.id)}
                        onDrop={(event) => dropTab(event, tab.id)}
                        onDragEnd={() => {
                          finishTabDrag()
                        }}
                        onDoubleClick={(event) => {
                          if ((event.target as Element).closest('.relay-split-pane-actions')) return
                          if (tabDragState || suppressMaximizeAfterDragRef.current) return
                          toggleLargestPane(tab.id)
                        }}
                      >
                        <button
                          className="relay-split-pane-activate"
                          type="button"
                          aria-pressed={isActive}
                          onClick={() => activateTab(tab.id)}
                          onKeyDown={(event) => keyboardReorder(event, tab.id)}
                          aria-keyshortcuts={onTabReorder ? 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight' : undefined}
                        >
                          <span className="relay-split-pane-title-group">
                            <span className="relay-split-pane-title" dir="auto">{chat.title}</span>
                            {isCompleted && (
                              <CompletionStatus title={chat.title} indicator={completionIndicator} />
                            )}
                          </span>
                        </button>
                        <span
                          className="relay-split-pane-actions"
                          draggable={false}
                          onDoubleClick={(event) => event.stopPropagation()}
                        >
                          {onNewTab && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                onNewTab(tab.id)
                              }}
                              aria-label={`New conversation from ${chat.title}`}
                              title="New conversation (Cmd/Ctrl+T)"
                            >
                              <Plus size={16} />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleLargestPane(tab.id)
                            }}
                            aria-label={isMaximized ? `Restore ${chat.title} pane size` : `Make ${chat.title} largest`}
                            title={isMaximized ? 'Restore pane sizes' : 'Make pane largest'}
                          >
                            {isMaximized ? <Columns3 size={15} /> : <MoveHorizontal size={15} />}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              hideTab(tab.id)
                            }}
                            aria-label={`Hide ${chat.title}`}
                            title="Hide pane"
                          >
                            <EyeOff size={15} />
                          </button>
                          {onCloseTab && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                onCloseTab(tab.id)
                              }}
                              aria-label={`Close ${chat.title}`}
                              title="Close tab"
                            >
                              <X size={15} />
                            </button>
                          )}
                        </span>
                      </div>
                    )}
                    <div
                      className="relay-split-pane-content"
                      onPointerDownCapture={() => {
                        if (!isActive) activateTab(tab.id)
                      }}
                      onFocusCapture={() => {
                        if (!isActive) activateTab(tab.id)
                      }}
                    >
                      {renderPane({
                        tab,
                        chat,
                        provider,
                        isActive,
                        isMaximized,
                        activate: () => activateTab(tab.id),
                        hide: () => hideTab(tab.id),
                        toggleMaximize: () => toggleLargestPane(tab.id),
                      })}
                    </div>
                  </article>

                  {viewMode === 'split' && nextTab && (
                    <div
                      className="relay-split-divider"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${chat.title} and ${chatById.get(nextTab.chatId)?.title ?? 'next conversation'}`}
                      aria-valuemin={minPaneWidth}
                      tabIndex={0}
                      onPointerDown={(event) => beginResize(event, tab.id, nextTab.id)}
                      onKeyDown={(event) => keyboardResize(event, tab.id, nextTab.id)}
                    >
                      <GripVertical size={14} aria-hidden="true" />
                    </div>
                  )}
                </Fragment>
              )
            })}
          </div>
        </div>
      )}

    </section>
  )
}

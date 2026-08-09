import {
  createWorkspaceSnapshotKeys,
  readWorkspaceSnapshot,
} from './workspacePersistence.mjs'
import {
  isNativeWorkspaceIdentity,
  workspaceStorageKey,
} from './nativeWorkspaceIdentity.mjs'
import { workspaceProjectHistoryScore } from './nativeWorkspaceRouting.mjs'

const CHAT_SCOPED_KEYS = [
  'chatSessions',
  'readCompletionByChat',
  'executionPanelOpenByChat',
  'drafts',
  'draftAttachments',
  'chatErrors',
  'chatExecutionEvents',
  'inFlightRuns',
  'promptQueues',
]

function pathKey(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function matchingProject(state, request) {
  const requestPath = pathKey(request?.projectPath)
  return (Array.isArray(state?.projects) ? state.projects : []).find((project) => project
    && (project.id === request?.projectId
      || (requestPath && pathKey(project.path) === requestPath))) ?? null
}

function emptyOpenedProjectState(request) {
  return {
    projects: [],
    activeProjectId: typeof request?.projectId === 'string' ? request.projectId : '',
    chats: [],
    tabs: [],
    activeTabId: '',
  }
}

function projectState(state, project) {
  const chats = (Array.isArray(state?.chats) ? state.chats : [])
    .filter((chat) => chat?.projectId === project.id)
  const chatIds = new Set(chats.map((chat) => chat.id))
  const tabs = (Array.isArray(state?.tabs) ? state.tabs : [])
    .filter((tab) => chatIds.has(tab?.chatId))
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const result = {
    projects: [project],
    activeProjectId: project.id,
    chats,
    tabs,
    activeTabId: tabIds.has(state?.activeTabId) ? state.activeTabId : tabs[0]?.id ?? '',
    placement: state?.placement,
    conversationLayout: state?.conversationLayout,
  }
  for (const key of CHAT_SCOPED_KEYS) {
    result[key] = Object.fromEntries(
      Object.entries(state?.[key] ?? {}).filter(([chatId]) => chatIds.has(chatId)),
    )
  }
  if (state?.splitLayout && typeof state.splitLayout === 'object') {
    result.splitLayout = {
      paneSizes: Object.fromEntries(
        Object.entries(state.splitLayout.paneSizes ?? {}).filter(([tabId]) => tabIds.has(tabId)),
      ),
      hiddenTabIds: (Array.isArray(state.splitLayout.hiddenTabIds) ? state.splitLayout.hiddenTabIds : [])
        .filter((tabId) => tabIds.has(tabId)),
      maximizedTabId: tabIds.has(state.splitLayout.maximizedTabId)
        ? state.splitLayout.maximizedTabId
        : null,
    }
  }
  return result
}

/**
 * Seeds a shell-created project window with only that project's checksummed
 * history from the source workspace. The source namespace remains unchanged.
 */
export function recoverOpenedProjectHistory(currentState, storage, options = {}) {
  const request = options.projectLaunch
  const sourceWorkspace = request?.sourceWorkspace
  const baseState = currentState && typeof currentState === 'object' && !Array.isArray(currentState)
    ? currentState
    : emptyOpenedProjectState(request)
  if (!request || typeof request.projectId !== 'string' || typeof request.projectPath !== 'string'
    || !isNativeWorkspaceIdentity(sourceWorkspace)
    || !storage || typeof storage.getItem !== 'function') {
    return { state: baseState, summary: { recovered: false, addedChats: 0 } }
  }

  const currentProject = matchingProject(baseState, request)
  if (currentProject && workspaceProjectHistoryScore(baseState, currentProject) > 0) {
    return { state: baseState, summary: { recovered: false, addedChats: 0 } }
  }

  const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, sourceWorkspace))
  const snapshot = readWorkspaceSnapshot(storage, { keys })
  const sourceProject = matchingProject(snapshot?.state, request)
  if (!snapshot || !sourceProject) {
    return { state: baseState, summary: { recovered: false, addedChats: 0 } }
  }
  const recovered = projectState(snapshot.state, sourceProject)
  return {
    state: recovered,
    summary: { recovered: true, addedChats: recovered.chats.length },
  }
}

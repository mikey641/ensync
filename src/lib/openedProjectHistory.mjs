import {
  createWorkspaceSnapshotKeys,
  readWorkspaceSnapshot,
  WORKSPACE_SNAPSHOT_STORAGE_KEY,
} from './workspacePersistence.mjs'
import {
  NATIVE_WORKSPACE_ID_PATTERN,
  isNativeWorkspaceIdentity,
  workspaceStorageKey,
} from './nativeWorkspaceIdentity.mjs'
import { workspaceProjectHistoryScore } from './nativeWorkspaceRouting.mjs'

const ISOLATED_PRIMARY_PATTERN = /^ensync-native-workspace:([0-9a-f-]{36}):ensync-workspace-snapshot-v3$/i
const MAX_STORED_WORKSPACES = 128

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

function meaningfulProjectSnapshot(snapshot, request, workspaceId) {
  const project = matchingProject(snapshot?.state, request)
  const score = project ? workspaceProjectHistoryScore(snapshot.state, project) : 0
  return snapshot && project && score > 0
    ? { snapshot, project, score, workspaceId }
    : null
}

function storedProjectSnapshots(storage, request, sourcePrimaryKey) {
  if (typeof storage?.key !== 'function' || !Number.isSafeInteger(storage.length)) return []
  const workspaces = new Map()
  for (let index = 0; index < storage.length && workspaces.size < MAX_STORED_WORKSPACES; index += 1) {
    const primaryKey = storage.key(index) ?? ''
    if (primaryKey === sourcePrimaryKey) continue
    if (primaryKey === WORKSPACE_SNAPSHOT_STORAGE_KEY) {
      workspaces.set('canonical', createWorkspaceSnapshotKeys())
      continue
    }
    const match = ISOLATED_PRIMARY_PATTERN.exec(primaryKey)
    const workspaceId = match?.[1]?.toLowerCase()
    if (workspaceId && NATIVE_WORKSPACE_ID_PATTERN.test(workspaceId)) {
      workspaces.set(
        workspaceId,
        createWorkspaceSnapshotKeys((key) => `ensync-native-workspace:${workspaceId}:${key}`),
      )
    }
  }
  return [...workspaces].flatMap(([workspaceId, keys]) => {
    const candidate = meaningfulProjectSnapshot(readWorkspaceSnapshot(storage, { keys }), request, workspaceId)
    return candidate ? [candidate] : []
  })
}

/**
 * Seeds a shell-created project window with the strongest checksummed history
 * for that exact project across the source and bounded stored workspaces. Every
 * source namespace remains unchanged.
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
  const source = meaningfulProjectSnapshot(readWorkspaceSnapshot(storage, { keys }), request, sourceWorkspace.id)
  const candidates = [
    ...(source ? [source] : []),
    ...storedProjectSnapshots(storage, request, keys.primary),
  ]
  candidates.sort((left, right) => right.score - left.score
    || right.snapshot.committedAt.localeCompare(left.snapshot.committedAt)
    || right.snapshot.revision - left.snapshot.revision
    || left.workspaceId.localeCompare(right.workspaceId))
  const selected = candidates[0]
  if (!selected) {
    return { state: baseState, summary: { recovered: false, addedChats: 0 } }
  }
  const recovered = projectState(selected.snapshot.state, selected.project)
  return {
    state: recovered,
    summary: { recovered: true, addedChats: recovered.chats.length },
  }
}

/**
 * Hydrates an otherwise empty native window when the user selects a project in
 * place (for example, Cmd/Ctrl+N followed by choosing a recent project). The
 * current workspace is treated only as the namespace to exclude/prefer during
 * the bounded checksummed search; every stored namespace remains unchanged.
 */
export function recoverFocusedProjectHistory(currentState, storage, options = {}) {
  const project = options.project
  const currentWorkspace = options.currentWorkspace
  if (!project || typeof project.id !== 'string' || typeof project.path !== 'string'
    || !isNativeWorkspaceIdentity(currentWorkspace)) {
    return {
      state: currentState,
      summary: { recovered: false, addedChats: 0 },
    }
  }

  const result = recoverOpenedProjectHistory(currentState, storage, {
    projectLaunch: {
      projectId: project.id,
      projectPath: project.path,
      sourceWorkspace: currentWorkspace,
    },
  })
  if (!result.summary.recovered) return result

  const recoveredProjectId = result.state.projects?.[0]?.id
  return {
    ...result,
    state: {
      ...result.state,
      projects: [project],
      activeProjectId: project.id,
      chats: result.state.chats.map((chat) => chat?.projectId === recoveredProjectId
        ? { ...chat, projectId: project.id }
        : chat),
    },
  }
}

import {
  createWorkspaceSnapshotKeys,
  readWorkspaceSnapshot,
} from './workspacePersistence.mjs'
import {
  NATIVE_WORKSPACE_ID_PATTERN,
  isNativeWorkspaceIdentity,
} from './nativeWorkspaceIdentity.mjs'
import { workspaceProjectHistoryScore } from './nativeWorkspaceRouting.mjs'
import { mergeRecoveredWorkspaceState } from './workspaceRecovery.mjs'

const RETIRED_PRIMARY_PATTERN = /^ensync-native-workspace:([0-9a-f-]{36}):ensync-workspace-snapshot-v3$/i
const MAX_RETIRED_WORKSPACES = 128
const MAX_RECOVERY_MARKERS = 256
const CHAT_SCOPED_KEYS = [
  'chatSessions',
  'readCompletionByChat',
  'executionPanelOpenByChat',
  'deliveryPanelOpenByChat',
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

function retiredWorkspaceIds(storage, retainedWorkspaceIds) {
  const retained = new Set(retainedWorkspaceIds.map((id) => id.toLowerCase()))
  const ids = new Set()
  const length = Number.isSafeInteger(storage?.length) && storage.length > 0 ? storage.length : 0
  for (let index = 0; index < length && ids.size < MAX_RETIRED_WORKSPACES; index += 1) {
    const match = RETIRED_PRIMARY_PATTERN.exec(storage.key(index) ?? '')
    const id = match?.[1]?.toLowerCase()
    if (id && NATIVE_WORKSPACE_ID_PATTERN.test(id) && !retained.has(id)) ids.add(id)
  }
  return [...ids].sort()
}

function projectState(state, project) {
  const chats = (Array.isArray(state?.chats) ? state.chats : [])
    .filter((chat) => chat?.projectId === project.id)
  const chatIds = new Set(chats.map((chat) => chat.id))
  const tabs = (Array.isArray(state?.tabs) ? state.tabs : [])
    .filter((tab) => chatIds.has(tab?.chatId))
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const filtered = {
    projects: [project],
    chats,
    tabs,
    activeProjectId: project.id,
    activeTabId: tabIds.has(state?.activeTabId) ? state.activeTabId : tabs[0]?.id ?? '',
  }
  for (const key of CHAT_SCOPED_KEYS) {
    filtered[key] = Object.fromEntries(
      Object.entries(state?.[key] ?? {}).filter(([chatId]) => chatIds.has(chatId)),
    )
  }
  return filtered
}

/**
 * A manually closed isolated window is no longer restored, but its checksummed
 * bytes remain recoverable. Canonical hydration imports only a project whose
 * current namespace has no meaningful history, preserving every source key.
 */
export function recoverArchivedProjectHistory(currentState, storage, options = {}) {
  const identity = options.identity
  if (!isNativeWorkspaceIdentity(identity) || identity.kind !== 'canonical'
    || !currentState || typeof currentState !== 'object' || Array.isArray(currentState)
    || !storage || typeof storage.getItem !== 'function' || typeof storage.key !== 'function') {
    return { state: currentState, summary: { scannedWorkspaces: 0, recoveredProjects: 0, addedChats: 0 } }
  }

  const applied = Array.isArray(currentState.archivedProjectRecoveryIds)
    ? currentState.archivedProjectRecoveryIds.filter((value) => typeof value === 'string')
    : []
  const appliedSet = new Set(applied)
  const candidates = []
  for (const workspaceId of retiredWorkspaceIds(storage, options.retainedWorkspaceIds ?? [])) {
    const keys = createWorkspaceSnapshotKeys((key) => `ensync-native-workspace:${workspaceId}:${key}`)
    const snapshot = readWorkspaceSnapshot(storage, { keys })
    if (snapshot) candidates.push({ workspaceId, snapshot })
  }
  candidates.sort((left, right) => right.snapshot.committedAt.localeCompare(left.snapshot.committedAt)
    || right.snapshot.revision - left.snapshot.revision
    || left.workspaceId.localeCompare(right.workspaceId))

  let state = currentState
  let recoveredProjects = 0
  let addedChats = 0
  const markers = [...applied]
  for (const candidate of candidates) {
    const sourceProjects = Array.isArray(candidate.snapshot.state?.projects)
      ? candidate.snapshot.state.projects
      : []
    for (const sourceProject of sourceProjects) {
      const targetProject = (Array.isArray(state.projects) ? state.projects : [])
        .find((project) => pathKey(project?.path) === pathKey(sourceProject?.path))
      if (!targetProject || workspaceProjectHistoryScore(candidate.snapshot.state, sourceProject) <= 0) continue
      const marker = `${candidate.workspaceId}:${candidate.snapshot.revision}:${sourceProject.id}`
      if (appliedSet.has(marker)) continue
      if (workspaceProjectHistoryScore(state, targetProject) > 0) {
        // Current history wins permanently for this exact source revision. This
        // also backfills a marker after an older build recovered the chats but
        // failed to serialize its marker into the canonical snapshot.
        markers.push(marker)
        appliedSet.add(marker)
        continue
      }
      const source = projectState(candidate.snapshot.state, sourceProject)
      const merged = mergeRecoveredWorkspaceState(state, source, { preserveHostJobs: true })
      const recoveredActiveTabId = merged.mappings.tabIdMap.get(source.activeTabId)
      state = {
        ...merged.state,
        activeTabId: state.activeProjectId === targetProject.id && recoveredActiveTabId
          ? recoveredActiveTabId
          : merged.state.activeTabId,
      }
      markers.push(marker)
      appliedSet.add(marker)
      recoveredProjects += 1
      addedChats += merged.summary.addedChats
    }
  }

  if (markers.length !== applied.length) {
    state = { ...state, archivedProjectRecoveryIds: markers.slice(-MAX_RECOVERY_MARKERS) }
  }
  return {
    state,
    summary: { scannedWorkspaces: candidates.length, recoveredProjects, addedChats },
  }
}

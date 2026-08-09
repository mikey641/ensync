import {
  isNativeWorkspaceIdentity,
  workspaceStorageKey,
} from './nativeWorkspaceIdentity.mjs'
import {
  createWorkspaceSnapshotKeys,
  readWorkspaceSnapshot,
} from './workspacePersistence.mjs'

const MAX_RETAINED_WORKSPACES = 32

export function nativeProjectPathKey(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function projectIdentity(project) {
  return {
    id: typeof project?.id === 'string' ? project.id : '',
    path: nativeProjectPathKey(project?.path),
  }
}

function matchingProjectIds(state, project) {
  const expected = projectIdentity(project)
  const ids = new Set()
  if (expected.id) ids.add(expected.id)
  for (const candidate of Array.isArray(state?.projects) ? state.projects : []) {
    if (!candidate || typeof candidate !== 'object') continue
    const sameId = expected.id && candidate.id === expected.id
    const samePath = expected.path && nativeProjectPathKey(candidate.path) === expected.path
    if ((sameId || samePath) && typeof candidate.id === 'string' && candidate.id) ids.add(candidate.id)
  }
  return ids
}

/**
 * Scores only durable user work. A freshly created empty "New conversation"
 * is deliberately zero so it cannot hide a different window's real history.
 */
export function workspaceProjectHistoryScore(state, project) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 0
  const projectIds = matchingProjectIds(state, project)
  if (projectIds.size === 0) return 0
  let score = 0
  for (const chat of Array.isArray(state.chats) ? state.chats : []) {
    if (!chat || typeof chat !== 'object' || !projectIds.has(chat.projectId)) continue
    const chatId = typeof chat.id === 'string' ? chat.id : ''
    const messages = Array.isArray(chat.messages) ? chat.messages.length : 0
    score += Math.min(messages, 100) * 100
    if (chat.continuation && typeof chat.continuation === 'object') score += 60
    if (chatId && typeof state.drafts?.[chatId] === 'string' && state.drafts[chatId].trim()) score += 80
    if (chatId && Array.isArray(state.draftAttachments?.[chatId]) && state.draftAttachments[chatId].length > 0) score += 80
    if (chatId && state.inFlightRuns?.[chatId]) score += 500
    if (chatId && Array.isArray(state.promptQueues?.[chatId]) && state.promptQueues[chatId].length > 0) score += 300
    if (chatId && typeof state.chatErrors?.[chatId] === 'string' && state.chatErrors[chatId]) score += 20
    if (chatId && Array.isArray(state.chatExecutionEvents?.[chatId]) && state.chatExecutionEvents[chatId].length > 0) score += 20
  }
  return score
}

/**
 * Finds another currently retained native workspace that already owns real
 * history for a project. Reads are checksummed and read-only; no namespace is
 * merged, copied, or deleted.
 */
export function findRetainedWorkspaceForProject(storage, options = {}) {
  if (!storage || typeof storage.getItem !== 'function') return null
  const currentWorkspace = options.currentWorkspace
  const retainedWorkspaces = Array.isArray(options.retainedWorkspaces)
    ? options.retainedWorkspaces.slice(0, MAX_RETAINED_WORKSPACES)
    : []
  const candidates = []
  for (const workspace of retainedWorkspaces) {
    if (!isNativeWorkspaceIdentity(workspace)
      || workspace.id === currentWorkspace?.id) continue
    const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, workspace))
    const snapshot = readWorkspaceSnapshot(storage, { keys })
    const score = workspaceProjectHistoryScore(snapshot?.state, options.project)
    if (!snapshot || score <= 0) continue
    const projectIds = matchingProjectIds(snapshot.state, options.project)
    const chatProjectId = (Array.isArray(snapshot.state.chats) ? snapshot.state.chats : [])
      .find((chat) => chat && projectIds.has(chat.projectId))?.projectId
    candidates.push({
      workspace: { id: workspace.id, kind: workspace.kind },
      projectId: typeof chatProjectId === 'string' ? chatProjectId : options.project?.id ?? '',
      projectPath: options.project?.path ?? '',
      score,
      revision: snapshot.revision,
      committedAt: snapshot.committedAt,
    })
  }
  candidates.sort((left, right) => right.score - left.score
    || right.committedAt.localeCompare(left.committedAt)
    || right.revision - left.revision
    || left.workspace.id.localeCompare(right.workspace.id))
  return candidates[0] ?? null
}

import {
  isNativeWorkspaceIdentity,
  workspaceStorageKey,
} from './nativeWorkspaceIdentity.mjs'
import {
  createWorkspaceSnapshotKeys,
  readWorkspaceSnapshot,
} from './workspacePersistence.mjs'

const MAX_RETAINED_WORKSPACES = 32
const PROTECTED_CONVERSATION_BRANCH_PATTERN = /^ensync\/chat-([0-9a-f]{24})$/i
const PROTECTED_CONVERSATION_REFERENCE_PATTERN = /\bensync\/chat-([0-9a-f]{6,24})(?=$|[^0-9a-f])/gi
const SHORT_WORKSPACE_REFERENCE_PATTERN = /\b([0-9a-f]{4,24})(?:…|\.{3})\s*(?:(?:protected|conversation)\s+)*(?:workspace|worktree|conversation)\b/gi
const FULL_WORKSPACE_PATH_REFERENCE_PATTERN = /(?:^|[\\/])([0-9a-f]{24})(?=$|[\\/\s,.;:)])/gi

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

function referencedConversationPrefixes(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : []
  const latest = messages.at(-1)
  if (latest?.role !== 'agent' || typeof latest.content !== 'string') return []
  return [...new Set([
    ...latest.content.matchAll(PROTECTED_CONVERSATION_REFERENCE_PATTERN),
    ...latest.content.matchAll(SHORT_WORKSPACE_REFERENCE_PATTERN),
    ...latest.content.matchAll(FULL_WORKSPACE_PATH_REFERENCE_PATTERN),
  ].map((match) => match[1]?.toLowerCase()).filter(Boolean))]
}

function conversationBranchSuffix(branch) {
  if (typeof branch !== 'string') return null
  return PROTECTED_CONVERSATION_BRANCH_PATTERN.exec(branch)?.[1]?.toLowerCase() ?? null
}

function projectDisplayName(project) {
  if (typeof project?.name === 'string' && project.name.trim()) return project.name.trim()
  if (typeof project?.path !== 'string') return 'Project'
  return project.path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? 'Project'
}

function absoluteLocalProjectPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (value.startsWith('/')) return value !== '/' && !/^\/+$/u.test(value)
  if (/^[a-z]:[\\/]/i.test(value)) return !/^[a-z]:[\\/]*$/i.test(value)
  return /^\\\\[^\\]+\\[^\\]+/.test(value)
}

function matchingConversationCandidates(state, workspace, prefixes, excludedChatId = null) {
  const projects = Array.isArray(state?.projects) ? state.projects : []
  return (Array.isArray(state?.chats) ? state.chats : []).flatMap((chat) => {
    const suffix = conversationBranchSuffix(chat?.workspace?.branch)
    if (chat?.id === excludedChatId || !suffix || !prefixes.some((prefix) => suffix.startsWith(prefix))
      || typeof chat?.id !== 'string' || !chat.id) return []
    const project = projects.find((candidate) => candidate?.id === chat.projectId)
    if (!project || typeof project.id !== 'string' || !project.id
      || !absoluteLocalProjectPath(project.path)) return []
    return [{
      workspaceId: workspace.id,
      projectId: project.id,
      projectPath: project.path,
      projectName: projectDisplayName(project),
      chatId: chat.id,
      chatTitle: typeof chat.title === 'string' && chat.title.trim()
        ? chat.title.trim()
        : 'Conversation',
      branch: chat.workspace.branch,
    }]
  })
}

/**
 * Resolves only a unique protected branch named by the latest completed agent
 * response. Candidate chats come from checksummed snapshots for shell-retained
 * workspaces; no worktree path is opened or inspected.
 */
export function findReferencedOwningConversation(storage, options = {}) {
  if (!isNativeWorkspaceIdentity(options.currentWorkspace)) return null
  const prefixes = referencedConversationPrefixes(options.chat)
  const currentSuffix = conversationBranchSuffix(options.chat?.workspace?.branch)
  const targetPrefixes = prefixes.filter((prefix) => !currentSuffix?.startsWith(prefix))
  if (targetPrefixes.length === 0) return null

  const retainedWorkspaces = Array.isArray(options.retainedWorkspaces)
    ? options.retainedWorkspaces.slice(0, MAX_RETAINED_WORKSPACES)
    : []
  const candidates = matchingConversationCandidates(
    options.currentState,
    options.currentWorkspace,
    targetPrefixes,
    options.chat?.id,
  )
  for (const workspace of retainedWorkspaces) {
    if (!isNativeWorkspaceIdentity(workspace)
      || workspace.id === options.currentWorkspace.id) continue
    if (!storage || typeof storage.getItem !== 'function') continue
    const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, workspace))
    const snapshot = readWorkspaceSnapshot(storage, { keys })
    if (!snapshot) continue
    candidates.push(...matchingConversationCandidates(snapshot.state, workspace, targetPrefixes))
  }
  const unique = new Map(candidates.map((candidate) => [
    `${candidate.workspaceId}\0${candidate.chatId}`,
    candidate,
  ]))
  return unique.size === 1 ? [...unique.values()][0] : null
}

/** Target-renderer guard for navigation to a retained chat without a live job. */
export function exactNativeChatFocusCanApply(request, current) {
  if (!request || !current || request.jobId !== undefined
    || typeof request.workspaceId !== 'string'
    || typeof request.projectId !== 'string'
    || typeof request.projectPath !== 'string'
    || typeof request.chatId !== 'string') return false
  return request.workspaceId.toLowerCase() === current.workspaceId?.toLowerCase()
    && request.projectId === current.projectId
    && nativeProjectPathKey(request.projectPath) === nativeProjectPathKey(current.projectPath)
    && request.chatId === current.chatId
}

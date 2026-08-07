import {
  createWorkspaceSnapshotKeys,
  readWorkspaceSnapshot,
} from './workspacePersistence.mjs'
import {
  NATIVE_WORKSPACE_ID_PATTERN,
  isNativeWorkspaceIdentity,
} from './nativeWorkspaceIdentity.mjs'

const RETIRED_PRIMARY_PATTERN = /^ensync-native-workspace:([0-9a-f-]{36}):ensync-workspace-snapshot-v3$/i
const MAX_RETIRED_WORKSPACES = 128
const MAX_RECENT_PROJECTS = 128
const MAX_RECOVERY_MARKERS = 256

function projectPathIdentity(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

function isAbsoluteProjectPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (value.startsWith('/')) return value !== '/' && !/^\/+$/u.test(value)
  if (/^[a-z]:[\\/]/i.test(value)) return !/^[a-z]:[\\/]*$/i.test(value)
  return /^\\\\[^\\]+\\[^\\]+/.test(value)
}

function projectName(project) {
  if (typeof project.name === 'string' && project.name.trim()) return project.name.trim().slice(0, 256)
  return project.path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.slice(0, 256) ?? 'Project'
}

function recoverableProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)
    || typeof project.id !== 'string' || project.id.length === 0 || project.id.length > 256
    || project.host !== 'local' || !isAbsoluteProjectPath(project.path)) return null
  return {
    id: project.id,
    name: projectName(project),
    path: project.path,
    host: 'local',
    context: {
      relayDirectory: false,
      files: [],
      featureFiles: [],
      truncated: false,
      error: null,
      instructionAdapters: [],
    },
    inspectedAt: typeof project.inspectedAt === 'string' ? project.inspectedAt : '',
    color: typeof project.color === 'string' ? project.color : '#93dfa0',
    verified: false,
  }
}

function candidateWorkspaceIds(storage, retainedWorkspaceIds) {
  const retained = new Set(retainedWorkspaceIds.map((id) => id.toLowerCase()))
  const ids = new Set()
  const length = Number.isSafeInteger(storage?.length) && storage.length > 0 ? storage.length : 0
  for (let index = 0; index < length; index += 1) {
    const key = storage.key(index)
    const match = typeof key === 'string' ? RETIRED_PRIMARY_PATTERN.exec(key) : null
    const id = match?.[1]?.toLowerCase()
    if (id && NATIVE_WORKSPACE_ID_PATTERN.test(id) && !retained.has(id)) ids.add(id)
  }
  return [...ids].sort().slice(0, MAX_RETIRED_WORKSPACES)
}

/**
 * Recovers only unverified recent-project entries from retired native-window
 * snapshots. Canonical state and active selection win; conversations, tabs,
 * drafts, queues, settings, and layout are never read into the result.
 */
export function recoverRecentProjectHistory(currentState, storage, options = {}) {
  const current = currentState && typeof currentState === 'object' && !Array.isArray(currentState)
    ? currentState
    : {}
  const identity = options.identity
  if (!isNativeWorkspaceIdentity(identity) || identity.kind !== 'canonical'
    || !storage || typeof storage.getItem !== 'function' || typeof storage.key !== 'function') {
    return { state: currentState, summary: { scannedWorkspaces: 0, addedProjects: 0 } }
  }

  const applied = Array.isArray(current.recentProjectRecoveryIds)
    ? current.recentProjectRecoveryIds.filter((value) => typeof value === 'string')
    : []
  const appliedSet = new Set(applied)
  const candidates = []
  const processedMarkers = []
  for (const workspaceId of candidateWorkspaceIds(storage, options.retainedWorkspaceIds ?? [])) {
    const keys = createWorkspaceSnapshotKeys((key) => `ensync-native-workspace:${workspaceId}:${key}`)
    const snapshot = readWorkspaceSnapshot(storage, { keys })
    if (!snapshot) continue
    const marker = `${workspaceId}:${snapshot.revision}:${snapshot.committedAt}`
    if (appliedSet.has(marker)) continue
    processedMarkers.push(marker)
    candidates.push({ workspaceId, snapshot })
  }

  candidates.sort((left, right) => right.snapshot.committedAt.localeCompare(left.snapshot.committedAt)
    || right.snapshot.revision - left.snapshot.revision
    || left.workspaceId.localeCompare(right.workspaceId))

  const currentProjects = Array.isArray(current.projects) ? current.projects : []
  const projects = [...currentProjects]
  const paths = new Set(currentProjects.map((project) => projectPathIdentity(project?.path)).filter(Boolean))
  const ids = new Set(currentProjects.map((project) => project?.id).filter((id) => typeof id === 'string'))
  let addedProjects = 0

  // A canonical v3 snapshot may have been created after only part of the old
  // v2 project list was carried forward. Treat legacy state as project-history
  // input even when v3 exists, but never import any of its other fields.
  const sourceStates = [
    ...(Array.isArray(options.legacyStates) ? options.legacyStates : []),
    ...candidates.map((candidate) => candidate.snapshot.state),
  ]
  for (const sourceState of sourceStates) {
    for (const source of Array.isArray(sourceState?.projects) ? sourceState.projects : []) {
      if (projects.length >= MAX_RECENT_PROJECTS) break
      const project = recoverableProject(source)
      const path = projectPathIdentity(project?.path)
      if (!project || !path || paths.has(path) || ids.has(project.id)) continue
      projects.push(project)
      paths.add(path)
      ids.add(project.id)
      addedProjects += 1
    }
  }

  if (processedMarkers.length === 0 && addedProjects === 0) {
    return { state: currentState, summary: { scannedWorkspaces: 0, addedProjects: 0 } }
  }
  const recentProjectRecoveryIds = [...new Set([...applied, ...processedMarkers])].slice(-MAX_RECOVERY_MARKERS)
  return {
    state: { ...current, projects, recentProjectRecoveryIds },
    summary: { scannedWorkspaces: candidates.length, addedProjects },
  }
}

import { createWorkspaceSnapshotKeys, readWorkspaceSnapshot } from './workspacePersistence.mjs'
import { getNativeWorkspaceIdentity, workspaceStorageKey } from './nativeWorkspaceIdentity.mjs'

const SCOPED_SNAPSHOT_PATTERN = /^ensync-native-workspace:([0-9a-f-]{36}):ensync-workspace-snapshot-v3(?:-(?:staging|backup))?$/i
const LEGACY_WORKSPACE_KEYS = ['ensync-workspace-v2', 'relay-workspace-v2']
const MAX_SOURCE_WORKSPACES = 128
const MAX_PROJECTS = 128

let recentProjects = Object.freeze([])
const listeners = new Set()
let removeNativeListener = null

function pathKey(value) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function normalizeProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)
    || project.host !== 'local' || typeof project.path !== 'string' || !project.path) return null
  const fallbackName = project.path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? 'Project'
  return Object.freeze({
    name: typeof project.name === 'string' && project.name.trim() ? project.name.trim() : fallbackName,
    path: project.path,
    host: 'local',
  })
}

function normalizeProjects(value) {
  if (!Array.isArray(value)) return []
  const result = []
  const paths = new Set()
  for (const candidate of value) {
    const project = normalizeProject(candidate)
    if (!project) continue
    const key = pathKey(project.path)
    if (paths.has(key)) continue
    paths.add(key)
    result.push(project)
    if (result.length >= MAX_PROJECTS) break
  }
  return result
}

function orderedSnapshotProjects(snapshot) {
  const projects = Array.isArray(snapshot?.state?.projects) ? snapshot.state.projects : []
  const activeId = snapshot?.state?.activeProjectId
  return [
    ...projects.filter((project) => project?.id === activeId),
    ...projects.filter((project) => project?.id !== activeId),
  ]
}

/** Read-only migration scan. It never mutates any workspace localStorage key. */
export function collectNativeRecentProjectCandidates(storage, identity = getNativeWorkspaceIdentity()) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.key !== 'function') return []
  const snapshots = []
  const seenScopes = new Set()
  const add = (scope, keys, priority) => {
    if (seenScopes.has(scope)) return
    seenScopes.add(scope)
    const snapshot = readWorkspaceSnapshot(storage, { keys })
    if (snapshot) snapshots.push({ scope, priority, snapshot })
  }

  const currentScope = identity?.kind === 'isolated' ? identity.id : 'canonical'
  add(currentScope, createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, identity)), 3)
  add('canonical', createWorkspaceSnapshotKeys(), 2)

  const scopedIds = new Set()
  const length = Number.isSafeInteger(storage.length) && storage.length > 0 ? storage.length : 0
  for (let index = 0; index < length && scopedIds.size < MAX_SOURCE_WORKSPACES; index += 1) {
    const match = SCOPED_SNAPSHOT_PATTERN.exec(storage.key(index) ?? '')
    if (match) scopedIds.add(match[1].toLowerCase())
  }
  for (const id of [...scopedIds].sort()) {
    add(id, createWorkspaceSnapshotKeys((key) => `ensync-native-workspace:${id}:${key}`), 1)
  }

  snapshots.sort((left, right) => right.priority - left.priority
    || right.snapshot.committedAt.localeCompare(left.snapshot.committedAt)
    || right.snapshot.revision - left.snapshot.revision
    || left.scope.localeCompare(right.scope))
  const legacyProjects = LEGACY_WORKSPACE_KEYS.flatMap((key) => {
    const value = storage.getItem(key)
    if (!value) return []
    try {
      const state = JSON.parse(value)
      return orderedSnapshotProjects({ state })
    } catch {
      return []
    }
  })
  return normalizeProjects([
    ...snapshots.flatMap(({ snapshot }) => orderedSnapshotProjects(snapshot)),
    ...legacyProjects,
  ])
}

function publish(value) {
  recentProjects = Object.freeze(normalizeProjects(value))
  for (const listener of listeners) listener([...recentProjects])
  return [...recentProjects]
}

export async function initializeNativeRecentProjects(target = globalThis) {
  const bridge = target?.ensyncDesktop
  if (typeof bridge?.getRecentProjects !== 'function'
    || typeof bridge?.migrateRecentProjects !== 'function'
    || typeof bridge?.onRecentProjectsChanged !== 'function') {
    return { status: 'unavailable', projects: [] }
  }
  removeNativeListener?.()
  removeNativeListener = bridge.onRecentProjectsChanged((state) => publish(state?.projects))
  const candidates = collectNativeRecentProjectCandidates(target.localStorage)
  const state = await bridge.migrateRecentProjects(candidates)
  if (!state || !Array.isArray(state.projects)) throw new Error('Ensync could not load global recent projects.')
  return { status: 'ready', projects: publish(state.projects) }
}

export function getNativeRecentProjects() {
  return [...recentProjects]
}

export function subscribeNativeRecentProjects(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function rememberNativeRecentProject(project, target = globalThis) {
  const bridge = target?.ensyncDesktop
  if (typeof bridge?.rememberRecentProject !== 'function') return getNativeRecentProjects()
  const state = await bridge.rememberRecentProject(project)
  return state && Array.isArray(state.projects) ? publish(state.projects) : getNativeRecentProjects()
}

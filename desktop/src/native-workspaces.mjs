import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const WORKSPACE_IDENTITY_CHANNEL = 'ensync:workspace:get-identity'
export const WORKSPACE_FOCUS_CHANNEL = 'ensync:workspace:focus'
export const WORKSPACE_OPEN_PROJECT_CHANNEL = 'ensync:workspace:open-project'
export const WORKSPACE_PROJECT_FOCUS_CHANNEL = 'ensync:workspace:focus-project'
export const NATIVE_WORKSPACE_STATE_FILENAME = 'native-workspaces-v1.json'
export const NATIVE_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const FORMAT = 'ensync-native-workspaces'
const VERSION = 1

export function isNativeWorkspaceIdentity(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && NATIVE_WORKSPACE_ID_PATTERN.test(value.id)
    && (value.kind === 'canonical' || value.kind === 'isolated'),
  )
}

export function shouldRetainNativeWorkspaceOnClose({ identity, quitting, platform, openWindowCount }) {
  if (!isNativeWorkspaceIdentity(identity)) return false
  return Boolean(quitting)
    || (identity.kind === 'canonical' && openWindowCount === 1)
    || (platform !== 'darwin' && openWindowCount === 1)
}

export function createNativeWorkspaceIdentity(kind, createId = randomUUID) {
  const identity = { id: createId(), kind }
  if (!isNativeWorkspaceIdentity(identity)) throw new Error('Could not create a valid native workspace identity.')
  return Object.freeze({ id: identity.id.toLowerCase(), kind })
}

/** The historical unsuffixed workspace always opens before clean UUID scopes. */
export function nativeWorkspaceRestorationOrder(workspaces) {
  const normalized = normalizeWorkspaces(workspaces)
  if (!normalized) throw new TypeError('Valid native workspace identities are required.')
  return [
    ...normalized.filter((identity) => identity.kind === 'canonical'),
    ...normalized.filter((identity) => identity.kind === 'isolated'),
  ]
}

function checksum(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeWorkspaces(value) {
  if (!Array.isArray(value) || value.length > 32) return null
  const result = []
  const ids = new Set()
  let canonicalCount = 0
  for (const candidate of value) {
    if (!isNativeWorkspaceIdentity(candidate) || ids.has(candidate.id.toLowerCase())) return null
    const identity = Object.freeze({ id: candidate.id.toLowerCase(), kind: candidate.kind })
    ids.add(identity.id)
    if (identity.kind === 'canonical') canonicalCount += 1
    if (canonicalCount > 1) return null
    result.push(identity)
  }
  return result
}

function decode(value) {
  try {
    const envelope = JSON.parse(value)
    if (!envelope || envelope.format !== FORMAT || envelope.version !== VERSION
      || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1
      || typeof envelope.payload !== 'string' || envelope.checksum !== checksum(envelope.payload)) return null
    const workspaces = normalizeWorkspaces(JSON.parse(envelope.payload))
    return workspaces ? { revision: envelope.revision, workspaces } : null
  } catch {
    return null
  }
}

function encode(workspaces, revision) {
  const payload = JSON.stringify(workspaces)
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    revision,
    checksum: checksum(payload),
    payload,
  })
}

/**
 * Records only the identities of native workspaces that should reopen. Chat
 * content remains in Chromium's stable-origin localStorage under scoped keys.
 */
export function createNativeWorkspaceStore({ filePath, createId = randomUUID } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('A native workspace state path is required.')
  const stagingPath = `${filePath}.staging`
  const readCandidate = (path) => {
    try { return decode(readFileSync(path, 'utf8')) } catch { return null }
  }
  const candidates = [readCandidate(filePath), readCandidate(stagingPath)].filter(Boolean)
  candidates.sort((left, right) => right.revision - left.revision)
  let revision = candidates[0]?.revision ?? 0
  let workspaces = candidates[0]?.workspaces ?? []

  const persist = () => {
    revision += 1
    const encoded = encode(workspaces, revision)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(stagingPath, encoded, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(filePath, encoded, { encoding: 'utf8', mode: 0o600 })
    try { rmSync(stagingPath) } catch {}
  }

  const create = (kind) => {
    const identity = createNativeWorkspaceIdentity(kind, createId)
    if (workspaces.some((item) => item.id === identity.id)) throw new Error('Native workspace identity collision.')
    if (kind === 'canonical' && workspaces.some((item) => item.kind === 'canonical')) {
      throw new Error('The canonical native workspace already exists.')
    }
    workspaces = [...workspaces, identity]
    persist()
    return identity
  }

  return {
    list() { return workspaces.map((identity) => ({ ...identity })) },
    ensureRestorable() {
      return workspaces.at(-1) ?? create('canonical')
    },
    ensureCanonical() {
      return workspaces.find((identity) => identity.kind === 'canonical') ?? create('canonical')
    },
    createIsolated() { return create('isolated') },
    remove(id) {
      const next = workspaces.filter((identity) => identity.id !== id)
      if (next.length === workspaces.length) return false
      workspaces = next
      persist()
      return true
    },
    touch(id) {
      const index = workspaces.findIndex((identity) => identity.id === id)
      if (index < 0 || index === workspaces.length - 1) return false
      const identity = workspaces[index]
      workspaces = [...workspaces.slice(0, index), ...workspaces.slice(index + 1), identity]
      persist()
      return true
    },
  }
}

export function createWorkspaceIdentityHandler({
  isAuthorized,
  identityForWebContents,
  retainedIdentities,
  projectLaunchForIdentity = () => null,
}) {
  if (typeof isAuthorized !== 'function' || typeof identityForWebContents !== 'function'
    || typeof retainedIdentities !== 'function' || typeof projectLaunchForIdentity !== 'function') {
    throw new TypeError('Workspace identity authorization is required.')
  }
  return async (event) => {
    if (!isAuthorized(event)) return null
    const identity = identityForWebContents(event.sender)
    const retainedWorkspaces = retainedIdentities()
      .filter(isNativeWorkspaceIdentity)
      .map((item) => ({ id: item.id, kind: item.kind }))
    const retainedWorkspaceIds = retainedWorkspaces.map((item) => item.id)
    if (!isNativeWorkspaceIdentity(identity)) return null
    const response = { id: identity.id, kind: identity.kind, retainedWorkspaceIds, retainedWorkspaces }
    const projectLaunch = normalizeWorkspaceProjectLaunch(projectLaunchForIdentity(identity), identity)
    return projectLaunch ? { ...response, projectLaunch } : response
  }
}

function absoluteLocalPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (value.startsWith('/')) return value !== '/' && !/^\/+$/u.test(value)
  if (/^[a-z]:[\\/]/i.test(value)) return !/^[a-z]:[\\/]*$/i.test(value)
  return /^\\\\[^\\]+\\[^\\]+/.test(value)
}

function normalizeProjectRequest(request) {
  if (!request || typeof request !== 'object'
    || typeof request.projectId !== 'string'
    || request.projectId.length === 0
    || request.projectId.length > 256
    || !absoluteLocalPath(request.projectPath)) return null
  return { projectId: request.projectId, projectPath: request.projectPath }
}

function normalizeWorkspaceProjectLaunch(value, targetIdentity) {
  const project = normalizeProjectRequest(value)
  const sourceWorkspace = value?.sourceWorkspace
  if (!project || !isNativeWorkspaceIdentity(targetIdentity)
    || !isNativeWorkspaceIdentity(sourceWorkspace)
    || sourceWorkspace.id === targetIdentity.id) return null
  return {
    ...project,
    sourceWorkspace: { id: sourceWorkspace.id, kind: sourceWorkspace.kind },
  }
}

export function createWorkspaceOpenProjectHandler({
  isAuthorized,
  identityForWebContents,
  openProjectWindow,
}) {
  for (const [name, value] of Object.entries({
    isAuthorized,
    identityForWebContents,
    openProjectWindow,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function.`)
  }
  return async (event, request) => {
    if (!isAuthorized(event)) return false
    const sourceWorkspace = identityForWebContents(event.sender)
    const project = normalizeProjectRequest(request)
    if (!isNativeWorkspaceIdentity(sourceWorkspace) || !project) return false
    return await openProjectWindow(project, sourceWorkspace) !== false
  }
}

export function createWorkspaceFocusHandler({
  isAuthorized,
  identityForWebContents,
  retainedIdentities,
  windowForWorkspace,
  openWorkspaceWindow,
  focusWindow,
  notifyProjectFocus,
}) {
  for (const [name, value] of Object.entries({
    isAuthorized,
    identityForWebContents,
    retainedIdentities,
    windowForWorkspace,
    openWorkspaceWindow,
    focusWindow,
    notifyProjectFocus,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function.`)
  }
  return async (event, request) => {
    if (!isAuthorized(event) || !request || typeof request !== 'object') return false
    const source = identityForWebContents(event.sender)
    const targetWorkspaceId = typeof request.workspaceId === 'string'
      ? request.workspaceId.toLowerCase()
      : ''
    if (!isNativeWorkspaceIdentity(source)
      || !NATIVE_WORKSPACE_ID_PATTERN.test(targetWorkspaceId)
      || source.id === targetWorkspaceId
      || typeof request.projectId !== 'string'
      || request.projectId.length === 0
      || request.projectId.length > 256
      || !absoluteLocalPath(request.projectPath)) return false
    const targetIdentity = retainedIdentities()
      .find((identity) => isNativeWorkspaceIdentity(identity) && identity.id === targetWorkspaceId)
    if (!targetIdentity) return false
    const targetWindow = windowForWorkspace(targetWorkspaceId)
      ?? await openWorkspaceWindow(targetIdentity, {
        projectId: request.projectId,
        projectPath: request.projectPath,
        sourceWorkspace: { id: source.id, kind: source.kind },
      })
    if (!targetWindow || await focusWindow(targetWindow) === false) return false
    await notifyProjectFocus(targetWindow, {
      projectId: request.projectId,
      projectPath: request.projectPath,
    })
    return true
  }
}

/**
 * Owns the single workspace-identity IPC handler for the lifetime of the native
 * window registry. Registration is synchronous and idempotent so startup,
 * activation, crash recovery, and New Window can all assert the bridge exists
 * immediately before a renderer is allowed to load.
 */
export function createWorkspaceIdentityIpcManager({
  ipcMain,
  isAuthorized,
  identityForWebContents,
  retainedIdentities,
  projectLaunchForIdentity,
  hasRegisteredWindows,
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.removeHandler !== 'function') {
    throw new TypeError('Electron IPC registration is required.')
  }
  if (typeof hasRegisteredWindows !== 'function') {
    throw new TypeError('Native window lifecycle state is required.')
  }

  const handler = createWorkspaceIdentityHandler({
    isAuthorized,
    identityForWebContents,
    retainedIdentities,
    projectLaunchForIdentity,
  })
  let registered = false

  return Object.freeze({
    register() {
      if (registered) return false
      ipcMain.handle(WORKSPACE_IDENTITY_CHANNEL, handler)
      registered = true
      return true
    },
    dispose() {
      if (!registered || hasRegisteredWindows()) return false
      ipcMain.removeHandler(WORKSPACE_IDENTITY_CHANNEL)
      registered = false
      return true
    },
    get registered() {
      return registered
    },
  })
}

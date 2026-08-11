import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const WORKSPACE_IDENTITY_CHANNEL = 'ensync:workspace:get-identity'
export const WORKSPACE_FOCUS_CHANNEL = 'ensync:workspace:focus'
export const WORKSPACE_OPEN_PROJECT_CHANNEL = 'ensync:workspace:open-project'
export const WORKSPACE_PROJECT_FOCUS_CHANNEL = 'ensync:workspace:focus-project'
export const ACTIVE_RUNS_PUBLISH_CHANNEL = 'ensync:workspace:publish-active-runs'
export const ACTIVE_RUN_MATCH_CHANNEL = 'ensync:workspace:match-active-run'
export const QUEUED_MESSAGE_HANDOFF_CHANNEL = 'ensync:workspace:handoff-queued-message'
export const QUEUED_MESSAGE_HANDOFF_ACK_CHANNEL = 'ensync:workspace:queued-message-handoff-ack'
export const QUEUED_MESSAGE_HANDOFF_EVENT_CHANNEL = 'ensync:workspace:queued-message-handoff'
export const NATIVE_WORKSPACE_STATE_FILENAME = 'native-workspaces-v1.json'
export const NATIVE_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const FORMAT = 'ensync-native-workspaces'
const VERSION = 1
const ACTIVE_RUN_LIMIT = 32
const HANDOFF_TIMEOUT_MS = 5_000
const HANDOFF_RECORD_LIMIT = 128
const QUEUED_PROMPT_MAX_LENGTH = 100_000
const QUEUED_PROMPT_ATTACHMENT_LIMIT = 64

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
    try { rmSync(stagingPath) } catch { /* best effort: a retained staging file is recovered on reopen */ }
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

function nonEmptyString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

/** Native active-run coordinates are exact strings, including the project path. */
export function normalizeExactRunTarget(request) {
  const project = normalizeProjectRequest(request)
  const workspaceId = typeof request?.workspaceId === 'string'
    ? request.workspaceId.toLowerCase()
    : ''
  if (!project || !NATIVE_WORKSPACE_ID_PATTERN.test(workspaceId)
    || !nonEmptyString(request?.chatId) || !nonEmptyString(request?.jobId)) return null
  return {
    workspaceId,
    projectId: project.projectId,
    projectPath: project.projectPath,
    chatId: request.chatId,
    jobId: request.jobId,
  }
}

function sameExactRunTarget(left, right) {
  return left.workspaceId === right.workspaceId
    && left.projectId === right.projectId
    && left.projectPath === right.projectPath
    && left.chatId === right.chatId
    && left.jobId === right.jobId
}

/**
 * Keeps the native process as the sole authority for live run coordinates.
 * A renderer can replace only the roster for its own authenticated workspace.
 */
export function createActiveRunRoster({ isAuthorized, identityForWebContents }) {
  if (typeof isAuthorized !== 'function' || typeof identityForWebContents !== 'function') {
    throw new TypeError('Active run authorization is required.')
  }
  const entriesByWorkspace = new Map()

  return Object.freeze({
    publish(event, entries) {
      if (!isAuthorized(event) || !Array.isArray(entries) || entries.length > ACTIVE_RUN_LIMIT) return false
      const identity = identityForWebContents(event.sender)
      if (!isNativeWorkspaceIdentity(identity)) return false
      const normalized = entries.map(normalizeExactRunTarget)
      if (normalized.some((entry) => !entry || entry.workspaceId !== identity.id)) return false
      const seen = new Set()
      for (const entry of normalized) {
        const key = JSON.stringify(entry)
        if (seen.has(key)) return false
        seen.add(key)
      }
      entriesByWorkspace.set(identity.id, normalized.map((entry) => ({ ...entry })))
      return true
    },
    matches(target) {
      const normalized = normalizeExactRunTarget(target)
      return Boolean(normalized && entriesByWorkspace.get(normalized.workspaceId)
        ?.some((entry) => sameExactRunTarget(entry, normalized)))
    },
    removeWorkspace(workspaceId) {
      const normalizedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.toLowerCase() : ''
      if (!NATIVE_WORKSPACE_ID_PATTERN.test(normalizedWorkspaceId)) return false
      return entriesByWorkspace.delete(normalizedWorkspaceId)
    },
    listForWorkspace(workspaceId) {
      const normalizedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.toLowerCase() : ''
      if (!NATIVE_WORKSPACE_ID_PATTERN.test(normalizedWorkspaceId)) return []
      return (entriesByWorkspace.get(normalizedWorkspaceId) ?? []).map((entry) => ({ ...entry }))
    },
  })
}

/** Lets an authorized renderer ask only about one exact shell-owned binding. */
export function createActiveRunMatchHandler({ isAuthorized, activeRuns }) {
  if (typeof isAuthorized !== 'function' || !activeRuns || typeof activeRuns.matches !== 'function') {
    throw new TypeError('Active run match authorization is required.')
  }
  return (event, request) => Boolean(isAuthorized(event) && activeRuns.matches(request))
}

function normalizeAttachment(value) {
  if (!value || typeof value !== 'object' || !nonEmptyString(value.name, 512)
    || !nonEmptyString(value.path, 4096)) return null
  return { name: value.name, path: value.path }
}

function normalizeQueuedPrompt(value, target) {
  if (!value || typeof value !== 'object'
    || !nonEmptyString(value.id) || !nonEmptyString(value.turnId)
    || !nonEmptyString(value.messageId) || !nonEmptyString(value.prompt, QUEUED_PROMPT_MAX_LENGTH)
    || !nonEmptyString(value.enqueuedAt, 128)
    || (value.predecessorTurnId !== null && !nonEmptyString(value.predecessorTurnId))
    || (value.resumeApprovedAt !== undefined && value.resumeApprovedAt !== null && !nonEmptyString(value.resumeApprovedAt, 128))
    || !value.preferences || typeof value.preferences !== 'object') return null
  const preferences = value.preferences
  if ((preferences.providerMode !== 'auto' && preferences.providerMode !== 'fixed')
    || !nonEmptyString(preferences.provider)
    || (preferences.sizeTier !== null && preferences.sizeTier !== undefined && !nonEmptyString(preferences.sizeTier, 64))
    || typeof preferences.automaticFallback !== 'boolean'
    || typeof preferences.autoContextSkill !== 'boolean'
    || !Array.isArray(preferences.fallbackProviderOrder)
    || preferences.fallbackProviderOrder.length > ACTIVE_RUN_LIMIT
    || preferences.fallbackProviderOrder.some((provider) => !nonEmptyString(provider))
    || !nonEmptyString(preferences.executionTargetKey)
    || preferences.projectId !== target.projectId
    || preferences.projectPath !== target.projectPath) return null
  const rawAttachments = value.attachments === undefined ? [] : value.attachments
  if (!Array.isArray(rawAttachments) || rawAttachments.length > QUEUED_PROMPT_ATTACHMENT_LIMIT) return null
  const attachments = rawAttachments.map(normalizeAttachment)
  if (attachments.some((attachment) => !attachment)) return null
  return {
    id: value.id,
    turnId: value.turnId,
    messageId: value.messageId,
    prompt: value.prompt,
    attachments,
    enqueuedAt: value.enqueuedAt,
    predecessorTurnId: value.predecessorTurnId,
    ...(value.resumeApprovedAt === undefined ? {} : { resumeApprovedAt: value.resumeApprovedAt }),
    preferences: {
      providerMode: preferences.providerMode,
      provider: preferences.provider,
      sizeTier: preferences.sizeTier ?? null,
      automaticFallback: preferences.automaticFallback,
      autoContextSkill: preferences.autoContextSkill,
      fallbackProviderOrder: [...preferences.fallbackProviderOrder],
      executionTargetKey: preferences.executionTargetKey,
      projectId: preferences.projectId,
      projectPath: preferences.projectPath,
    },
  }
}

function normalizeHandoffRequest(request) {
  const handoffId = nonEmptyString(request?.handoffId) ? request.handoffId : null
  const target = normalizeExactRunTarget(request?.target)
  if (!handoffId || !target) return null
  const entry = normalizeQueuedPrompt(request.entry, target)
  return entry ? { handoffId, target, entry } : null
}

function handoffResult(status, handoffId, messageId) {
  return { status, handoffId, messageId }
}

function handoffDigest(request) {
  return checksum(JSON.stringify({
    ...request,
    entry: {
      ...request.entry,
      // Approval time is audit metadata. The presence of approval changes the
      // action identity, while a retry keeps the first accepted timestamp.
      resumeApprovedAt: request.entry.resumeApprovedAt == null ? null : true,
    },
  }))
}

/**
 * Sends one stable queued prompt to the exact active-run owner and resolves
 * only after that renderer persists and ACKs it. The returned handlers are
 * owned by main.mjs, where window close calls removeWorkspace().
 */
export function createQueuedMessageHandoffHandlers({
  isAuthorized,
  identityForWebContents,
  activeRuns,
  windowForWorkspace,
  sendToWebContents = (webContents, channel, payload) => webContents.send(channel, payload),
  timeoutMs = HANDOFF_TIMEOUT_MS,
  maxRetainedRecords = HANDOFF_RECORD_LIMIT,
}) {
  for (const [name, value] of Object.entries({
    isAuthorized,
    identityForWebContents,
    windowForWorkspace,
    sendToWebContents,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function.`)
  }
  if (!activeRuns || typeof activeRuns.matches !== 'function' || typeof activeRuns.removeWorkspace !== 'function') {
    throw new TypeError('An active run roster is required.')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('A positive handoff timeout is required.')
  if (!Number.isSafeInteger(maxRetainedRecords) || maxRetainedRecords < 1) {
    throw new TypeError('A positive retained handoff limit is required.')
  }

  const records = new Map()
  const finish = (record, result) => {
    if (record.result) return
    clearTimeout(record.timer)
    record.result = result
    record.resolve(result)
  }
  const reserveRecordCapacity = () => {
    while (records.size >= maxRetainedRecords) {
      let completedId = null
      for (const [handoffId, record] of records) {
        if (record.result) {
          completedId = handoffId
          break
        }
      }
      if (!completedId) return false
      records.delete(completedId)
    }
    return true
  }

  return Object.freeze({
    handoff(event, request) {
      const fallbackId = nonEmptyString(request?.handoffId) ? request.handoffId : ''
      const fallbackMessageId = nonEmptyString(request?.entry?.messageId) ? request.entry.messageId : ''
      if (!isAuthorized(event)) {
        return Promise.resolve(handoffResult('rejected', fallbackId, fallbackMessageId))
      }
      const source = identityForWebContents(event.sender)
      if (!isNativeWorkspaceIdentity(source)) {
        return Promise.resolve(handoffResult('rejected', fallbackId, fallbackMessageId))
      }
      const normalized = normalizeHandoffRequest(request)
      if (!normalized) {
        return Promise.resolve(handoffResult('rejected', fallbackId, fallbackMessageId))
      }
      if (source.id === normalized.target.workspaceId) {
        return Promise.resolve(handoffResult('rejected', normalized.handoffId, normalized.entry.messageId))
      }
      const digest = handoffDigest(normalized)
      const existing = records.get(normalized.handoffId)
      if (existing) {
        if (existing.sourceWorkspaceId !== source.id || existing.digest !== digest) {
          return Promise.resolve(handoffResult('rejected', normalized.handoffId, normalized.entry.messageId))
        }
        if (existing.result?.status !== 'unavailable') return existing.promise

        // A target may have durably accepted just before its ACK timed out or
        // its renderer closed. Re-deliver only the exact original request to
        // the same authenticated workspace so its persistent tombstone can
        // reconcile ownership. A current active-run roster is not required:
        // the original record proves this exact target was authorized.
        const retryWindow = windowForWorkspace(existing.target.workspaceId)
        const retryIdentity = retryWindow && identityForWebContents(retryWindow.webContents)
        if (!retryWindow || !isNativeWorkspaceIdentity(retryIdentity)
          || retryIdentity.id !== existing.target.workspaceId) return existing.promise
        records.delete(normalized.handoffId)
      }
      if (!existing && !activeRuns.matches(normalized.target)) {
        return Promise.resolve(handoffResult('rejected', normalized.handoffId, normalized.entry.messageId))
      }
      if (!reserveRecordCapacity()) {
        return Promise.resolve(handoffResult('unavailable', normalized.handoffId, normalized.entry.messageId))
      }
      const delivery = existing?.request ?? normalized
      const targetWindow = windowForWorkspace(delivery.target.workspaceId)
      if (!targetWindow || identityForWebContents(targetWindow.webContents) == null
        || identityForWebContents(targetWindow.webContents).id !== delivery.target.workspaceId) {
        return Promise.resolve(handoffResult('unavailable', normalized.handoffId, normalized.entry.messageId))
      }
      let resolve
      const promise = new Promise((complete) => { resolve = complete })
      const record = {
        digest,
        sourceWorkspaceId: source.id,
        target: delivery.target,
        messageId: delivery.entry.messageId,
        request: delivery,
        promise,
        resolve,
        result: null,
        timer: null,
      }
      record.timer = setTimeout(() => {
        finish(record, handoffResult('unavailable', normalized.handoffId, record.messageId))
      }, timeoutMs)
      records.set(normalized.handoffId, record)
      try {
        sendToWebContents(targetWindow.webContents, QUEUED_MESSAGE_HANDOFF_EVENT_CHANNEL, delivery)
      } catch {
        finish(record, handoffResult('unavailable', normalized.handoffId, record.messageId))
      }
      return promise
    },
    ack(event, response) {
      const handoffId = nonEmptyString(response?.handoffId) ? response.handoffId : null
      const record = handoffId ? records.get(handoffId) : null
      if (!record || record.result || !isAuthorized(event)) return false
      const identity = identityForWebContents(event.sender)
      if (!isNativeWorkspaceIdentity(identity) || identity.id !== record.target.workspaceId
        || response?.messageId !== record.messageId) return false
      if (response.status === 'accepted') {
        finish(record, handoffResult('accepted', handoffId, record.messageId))
        return true
      }
      if (response.status === 'rejected') {
        finish(record, handoffResult('rejected', handoffId, record.messageId))
        return true
      }
      return false
    },
    removeWorkspace(workspaceId) {
      const normalizedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.toLowerCase() : ''
      const removed = activeRuns.removeWorkspace(normalizedWorkspaceId)
      for (const [handoffId, record] of records) {
        if (record.sourceWorkspaceId === normalizedWorkspaceId) {
          if (!record.result) {
            finish(record, handoffResult('unavailable', handoffId, record.messageId))
          }
          records.delete(handoffId)
        } else if (!record.result && record.target.workspaceId === normalizedWorkspaceId) {
          finish(record, handoffResult('unavailable', handoffId, record.messageId))
        }
      }
      return removed
    },
    get retainedRecordCount() {
      return records.size
    },
  })
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
  focusWindow,
  notifyProjectFocus,
  activeRuns = null,
}) {
  for (const [name, value] of Object.entries({
    isAuthorized,
    identityForWebContents,
    retainedIdentities,
    windowForWorkspace,
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
    const hasExactBinding = request.chatId !== undefined || request.jobId !== undefined
    const exact = hasExactBinding ? normalizeExactRunTarget(request) : null
    if (!isNativeWorkspaceIdentity(source)
      || !NATIVE_WORKSPACE_ID_PATTERN.test(targetWorkspaceId)
      || source.id === targetWorkspaceId
      || typeof request.projectId !== 'string'
      || request.projectId.length === 0
      || request.projectId.length > 256
      || !absoluteLocalPath(request.projectPath)
      || (hasExactBinding && (!exact || !activeRuns?.matches(exact)))) return false
    const targetIdentity = retainedIdentities()
      .find((identity) => isNativeWorkspaceIdentity(identity) && identity.id === targetWorkspaceId)
    if (!targetIdentity) return false
    const targetWindow = windowForWorkspace(targetWorkspaceId)
    if (!targetWindow || await focusWindow(targetWindow) === false) return false
    await notifyProjectFocus(targetWindow, exact ?? {
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

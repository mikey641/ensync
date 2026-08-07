export const WORKSPACE_SNAPSHOT_STORAGE_KEY = 'ensync-workspace-snapshot-v3'
export const WORKSPACE_SNAPSHOT_STAGING_KEY = 'ensync-workspace-snapshot-v3-staging'
export const WORKSPACE_SNAPSHOT_BACKUP_KEY = 'ensync-workspace-snapshot-v3-backup'

const SNAPSHOT_FORMAT = 'ensync-workspace'
const SNAPSHOT_VERSION = 3

export function createWorkspaceSnapshotKeys(storageKeyFor = (key) => key) {
  if (typeof storageKeyFor !== 'function') throw new TypeError('A workspace storage-key resolver is required.')
  return Object.freeze({
    primary: storageKeyFor(WORKSPACE_SNAPSHOT_STORAGE_KEY),
    staging: storageKeyFor(WORKSPACE_SNAPSHOT_STAGING_KEY),
    backup: storageKeyFor(WORKSPACE_SNAPSHOT_BACKUP_KEY),
  })
}

const DEFAULT_SNAPSHOT_KEYS = createWorkspaceSnapshotKeys()

function snapshotKeys(options) {
  const keys = options?.keys ?? DEFAULT_SNAPSHOT_KEYS
  if (!keys || typeof keys.primary !== 'string' || typeof keys.staging !== 'string' || typeof keys.backup !== 'string') {
    throw new TypeError('Valid primary, staging, and backup workspace keys are required.')
  }
  return keys
}

function checksum(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function decodeSnapshot(value, source) {
  if (!value) return null
  try {
    const envelope = JSON.parse(value)
    if (!envelope || typeof envelope !== 'object'
      || envelope.format !== SNAPSHOT_FORMAT
      || envelope.version !== SNAPSHOT_VERSION
      || !Number.isSafeInteger(envelope.revision)
      || envelope.revision < 1
      || typeof envelope.committedAt !== 'string'
      || typeof envelope.payload !== 'string'
      || typeof envelope.checksum !== 'string'
      || checksum(envelope.payload) !== envelope.checksum) return null

    const state = JSON.parse(envelope.payload)
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null
    return {
      source,
      revision: envelope.revision,
      committedAt: envelope.committedAt,
      state,
      encoded: value,
    }
  } catch {
    return null
  }
}

/**
 * Reads the newest fully written, checksummed snapshot. Staging is a valid
 * synchronous commit: if the renderer died before promotion, its complete
 * bytes are newer than primary and are recovered on the next launch.
 */
export function readWorkspaceSnapshot(storage, options = {}) {
  const keys = snapshotKeys(options)
  const candidates = [
    decodeSnapshot(storage.getItem(keys.primary), 'primary'),
    decodeSnapshot(storage.getItem(keys.staging), 'staging'),
    decodeSnapshot(storage.getItem(keys.backup), 'backup'),
  ].filter(Boolean)
  if (candidates.length === 0) return null

  const priority = { primary: 3, staging: 2, backup: 1 }
  candidates.sort((left, right) => right.revision - left.revision
    || priority[right.source] - priority[left.source])
  const selected = candidates[0]
  return {
    state: selected.state,
    revision: selected.revision,
    committedAt: selected.committedAt,
    source: selected.source,
    recovered: selected.source !== 'primary',
  }
}

function encodeSnapshot(state, revision, committedAt) {
  const payload = JSON.stringify(state)
  return JSON.stringify({
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    revision,
    committedAt,
    checksum: checksum(payload),
    payload,
  })
}

/**
 * Commits synchronously using staging -> backup -> primary. localStorage writes
 * are atomic per key; a failure leaves either the staged commit or the previous
 * primary/backup readable. This cannot recover state that was never written.
 */
export function commitWorkspaceSnapshot(storage, state, options = {}) {
  const keys = snapshotKeys(options)
  const current = readWorkspaceSnapshot(storage, { keys })
  const committedAt = options.now?.() ?? new Date().toISOString()
  const revision = (current?.revision ?? 0) + 1
  const encoded = encodeSnapshot(state, revision, committedAt)

  storage.setItem(keys.staging, encoded)
  if (storage.getItem(keys.staging) !== encoded) {
    throw new Error('The workspace staging snapshot could not be verified.')
  }

  const primary = storage.getItem(keys.primary)
  if (decodeSnapshot(primary, 'primary')) {
    try {
      storage.setItem(keys.backup, primary)
    } catch {
      // The verified primary still protects the previous commit when storage is
      // too full to duplicate it as a second fallback.
    }
  }

  try {
    storage.setItem(keys.primary, encoded)
  } catch {
    // Staging is itself a complete checksummed synchronous commit. Keep it when
    // quota prevents promotion; the reader selects its newer revision.
    return { revision, committedAt, source: 'staging' }
  }
  if (storage.getItem(keys.primary) !== encoded) {
    return { revision, committedAt, source: 'staging' }
  }
  storage.removeItem(keys.staging)

  return { revision, committedAt, source: 'primary' }
}

function eventSize(event) {
  try {
    return JSON.stringify(event).length
  } catch {
    return 0
  }
}

/**
 * Keeps terminal history from consuming the synchronous storage budget needed
 * by chats, tabs, drafts, and layout. Every chat retains its newest events and
 * receives an explicit notice when older output was omitted from persistence.
 */
export function compactWorkspaceSnapshot(state, options = {}) {
  const eventsByChat = state.chatExecutionEvents
  if (!eventsByChat || typeof eventsByChat !== 'object') return state
  const entries = Object.entries(eventsByChat)
  if (entries.length === 0) return state

  const totalLimit = options.maxExecutionEventCharacters ?? 384 * 1024
  const perChatLimit = Math.max(0, Math.floor(totalLimit / entries.length))
  const eventBudget = Math.max(0, perChatLimit - 256)
  const compacted = {}
  for (const [chatId, eventsValue] of entries) {
    const events = Array.isArray(eventsValue) ? eventsValue : []
    const retained = []
    let retainedSize = 0
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index]
      const size = eventSize(candidate)
      if (retainedSize + size > eventBudget) break
      retained.unshift(candidate)
      retainedSize += size
    }
    if (retained.length < events.length) {
      const omissionNotice = {
        type: 'notice',
        message: 'Earlier CLI output remains outside this crash-recovery snapshot because terminal history is storage-bounded.',
        at: retained[0]?.at ?? new Date(0).toISOString(),
      }
      if (eventSize(omissionNotice) <= perChatLimit - retainedSize) retained.unshift(omissionNotice)
    }
    compacted[chatId] = retained
  }
  return { ...state, chatExecutionEvents: compacted }
}

export const INTERRUPTION_MESSAGE = 'This run was interrupted before Ensync received a final result. Project activity may be partial; reconcile the project before continuing.'

const HOST_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/

function recoverableHostJob(run) {
  return run
    && typeof run === 'object'
    && typeof run.jobId === 'string'
    && HOST_JOB_ID_PATTERN.test(run.jobId)
}

/**
 * A renderer cannot prove what an already-started CLI changed after it died.
 * Convert every persisted pending turn/run into an explicit interrupted,
 * reconciliation-required state and discard its provider session.
 */
export function reconcileInterruptedWorkspaceState(state, options = {}) {
  const inFlightRuns = state.inFlightRuns && typeof state.inFlightRuns === 'object'
    ? state.inFlightRuns
    : {}
  const retainedInFlightRuns = options.preserveHostJobs
    ? Object.fromEntries(Object.entries(inFlightRuns).filter(([, run]) => recoverableHostJob(run)))
    : {}
  const retainedChatIds = new Set(Object.keys(retainedInFlightRuns))
  const interruptedChatIds = new Set(
    Object.keys(inFlightRuns).filter((chatId) => !retainedChatIds.has(chatId)),
  )

  for (const chat of Array.isArray(state.chats) ? state.chats : []) {
    if (Array.isArray(chat.messages)
      && !retainedChatIds.has(chat.id)
      && chat.messages.some((message) => message?.role === 'user' && message.deliveryStatus === 'pending')) {
      interruptedChatIds.add(chat.id)
    }
  }

  if (interruptedChatIds.size === 0) {
    return { state: { ...state, inFlightRuns: retainedInFlightRuns }, interruptedChatIds: [] }
  }

  const interruptedAt = options.now?.() ?? new Date().toISOString()
  const chats = (Array.isArray(state.chats) ? state.chats : []).map((chat) => {
    if (!interruptedChatIds.has(chat.id)) return chat
    const run = inFlightRuns[chat.id] ?? {}
    const pending = Array.isArray(chat.messages)
      ? [...chat.messages].reverse().find((message) => message?.role === 'user' && message.deliveryStatus === 'pending')
      : null
    const turnId = run.turnId ?? pending?.turnId ?? `interrupted-${chat.id}`
    const provider = run.provider ?? chat.provider
    const attemptedProviders = Array.isArray(run.attemptedProviders) && run.attemptedProviders.length > 0
      ? run.attemptedProviders
      : [provider]

    return {
      ...chat,
      subtitle: 'Interrupted by restart',
      messages: (Array.isArray(chat.messages) ? chat.messages : []).map((message) =>
        message?.role === 'user' && message.deliveryStatus === 'pending'
          ? { ...message, deliveryStatus: 'interrupted' }
          : message),
      continuation: {
        turnId,
        status: 'reconciliation_required',
        termination: 'interrupted',
        reconciliationRequired: true,
        provider,
        model: null,
        sizeTier: run.sizeTier ?? chat.sizeTier ?? null,
        executionTarget: run.executionTarget ?? chat.continuation?.executionTarget ?? 'unknown',
        sessionResumable: false,
        attemptedProviders,
        fallbackReason: run.fallbackReason ?? null,
        completedAt: interruptedAt,
        gitBefore: run.gitBefore ?? chat.continuation?.gitBefore ?? null,
        gitAfter: null,
        gitReason: INTERRUPTION_MESSAGE,
        semanticSummary: chat.continuation?.semanticSummary ?? null,
      },
    }
  })

  const chatSessions = { ...(state.chatSessions ?? {}) }
  const chatErrors = { ...(state.chatErrors ?? {}) }
  const chatExecutionEvents = { ...(state.chatExecutionEvents ?? {}) }
  for (const chatId of interruptedChatIds) {
    delete chatSessions[chatId]
    chatErrors[chatId] = INTERRUPTION_MESSAGE
    const events = Array.isArray(chatExecutionEvents[chatId]) ? chatExecutionEvents[chatId] : []
    chatExecutionEvents[chatId] = [...events, {
      type: 'finished',
      outcome: 'interrupted',
      message: INTERRUPTION_MESSAGE,
      code: 'run_interrupted',
      safeToRetry: false,
      at: interruptedAt,
    }]
  }

  return {
    state: {
      ...state,
      chats,
      chatSessions,
      chatErrors,
      chatExecutionEvents,
      inFlightRuns: retainedInFlightRuns,
    },
    interruptedChatIds: [...interruptedChatIds],
  }
}

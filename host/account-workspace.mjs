export const ACCOUNT_WORKSPACE_FORMAT = 'ensync-account-conversations'
export const ACCOUNT_WORKSPACE_VERSION = 1

const EMPTY_PROJECT_CONTEXT = Object.freeze({
  ensyncDirectory: false,
  files: [],
  featureFiles: [],
  truncated: false,
  error: null,
  instructionAdapters: [],
})

const TERMINAL_DELIVERY_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

const SETTLED_DELIVERY_STATES = new Set(['completed', 'failed', 'cancelled'])

const DELIVERY_PRIORITY = Object.freeze({
  transferred: 1,
  queued: 2,
  pending: 3,
  failed: 4,
  interrupted: 5,
  cancelled: 6,
  completed: 7,
})

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function portableMessage(value) {
  const message = record(value)
  if (!message || !text(message.id) || !['user', 'agent'].includes(message.role)) return null
  const deliveryStatus = typeof message.deliveryStatus === 'string'
    ? message.deliveryStatus
    : undefined
  const transferredHandoff = deliveryStatus === 'transferred'
    || (deliveryStatus === 'interrupted' && message.handoffTransferred === true)
  const portable = {
    ...message,
    content: text(message.content),
    time: text(message.time),
    ...(TERMINAL_DELIVERY_STATES.has(deliveryStatus)
      ? { deliveryStatus }
      : deliveryStatus
        ? { deliveryStatus: 'interrupted' }
        : {}),
    // Account sync cannot execute a native-window transfer. Preserve only this
    // internal precedence marker so its target's local queued copy wins later.
    ...(transferredHandoff ? { handoffTransferred: true } : {}),
    // Local paths are never portable. The message text and attachment names
    // remain visible in the source workspace; another device cannot execute
    // or resolve the file reference.
    attachments: undefined,
    sessionResumable: false,
  }
  if (!transferredHandoff) delete portable.handoffTransferred
  // This receipt can contain local project and attachment identity. It remains
  // in the originating workspace snapshot and never enters account sync.
  delete portable.handoffTombstone
  return portable
}

// ---- live turn (transient progress of a run that is still going) ----------
//
// `chat.liveTurn` mirrors what the desktop shows under the last prompt while a
// provider works: the provider, when the turn started, and its most recent
// CLI-visible progress notes (already redacted by Ensync Host). It is never a
// message, so it cannot duplicate one, and it is strictly whitelisted: no
// terminal output, commands, paths or attachments. Clients that predate it
// rebuild chats from known fields and simply drop it.

export const LIVE_TURN_NOTE_LIMIT = 6
export const LIVE_TURN_NOTE_MAX_CHARACTERS = 2_000
/** A running turn republishes at least this often so a crashed writer goes stale. */
export const LIVE_TURN_HEARTBEAT_MS = 60_000
/** Readers stop showing a live turn that has not been refreshed for this long. */
export const LIVE_TURN_STALE_MS = 3 * 60_000
const MAX_LIVE_IDENTIFIER_CHARACTERS = 480

function liveIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LIVE_IDENTIFIER_CHARACTERS
    ? value
    : null
}

function isoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function portableLiveNote(value) {
  const note = record(value)
  if (!note || typeof note.text !== 'string' || !note.text.trim()) return null
  const noteText = note.text.length > LIVE_TURN_NOTE_MAX_CHARACTERS
    ? `${note.text.slice(0, LIVE_TURN_NOTE_MAX_CHARACTERS - 1)}…`
    : note.text
  return {
    ...(liveIdentifier(note.provider) ? { provider: note.provider } : {}),
    text: noteText,
    redacted: note.redacted === true,
    ...(isoTime(note.at) ? { at: note.at } : {}),
  }
}

export function portableLiveTurn(value) {
  const live = record(value)
  if (!live || live.status !== 'running') return undefined
  const turnId = liveIdentifier(live.turnId)
  const startedAt = isoTime(live.startedAt)
  if (!turnId || !startedAt) return undefined
  const notes = (Array.isArray(live.notes) ? live.notes : [])
    .map(portableLiveNote)
    .filter(Boolean)
    .slice(-LIVE_TURN_NOTE_LIMIT)
  return {
    turnId,
    status: 'running',
    provider: liveIdentifier(live.provider) ?? 'codex',
    startedAt,
    updatedAt: isoTime(live.updatedAt) ?? startedAt,
    origin: live.origin === 'host' ? 'host' : 'desktop',
    ...(liveIdentifier(live.messageId) ? { messageId: live.messageId } : {}),
    ...(liveIdentifier(live.jobId) ? { jobId: live.jobId } : {}),
    notes,
  }
}

/**
 * True once the transcript already records how this turn ended: its reply
 * landed, or its prompt reached a terminal delivery state. A settled live turn
 * is dropped everywhere, so finishing a turn clears its progress on every
 * device even when an older copy of the progress is merged back in later.
 */
export function liveTurnSettled(messages, liveTurn) {
  if (!liveTurn) return true
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (!message) return false
    const sameTurn = (typeof message.turnId === 'string' && message.turnId === liveTurn.turnId)
      || (liveTurn.messageId && message.id === liveTurn.messageId)
      || message.id === liveTurn.turnId
    if (!sameTurn) return false
    // `interrupted` is also how a still-running prompt is written into the
    // portable document, so it does not end a live turn; a writer that really
    // stopped lets its live turn go stale instead.
    return message.role === 'agent' || SETTLED_DELIVERY_STATES.has(message.deliveryStatus)
  })
}

function liveTurnTime(liveTurn) {
  const parsed = Date.parse(liveTurn?.updatedAt ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** The fresher of two live turns: newest `updatedAt`, then more notes, then `preferred`. */
function newerLiveTurn(preferred, other) {
  if (!preferred) return other
  if (!other) return preferred
  const difference = liveTurnTime(preferred) - liveTurnTime(other)
  if (difference !== 0) return difference > 0 ? preferred : other
  return (other.notes?.length ?? 0) > (preferred.notes?.length ?? 0) ? other : preferred
}

/**
 * Whether a reader should show this chat's live turn now. A writer that died
 * mid-turn stops refreshing it, so it ages out instead of spinning forever.
 */
export function activeLiveTurn(chat, nowMs = Date.now()) {
  const live = portableLiveTurn(chat?.liveTurn)
  if (!live || liveTurnSettled(chat?.messages, live)) return null
  if (Number.isFinite(nowMs) && nowMs - liveTurnTime(live) > LIVE_TURN_STALE_MS) return null
  return live
}

/**
 * Builds the live turn a writer publishes for one running run. `events` are
 * the run's execution events; only `note` events are read.
 */
export function buildLiveTurn({ turnId, provider, startedAt, events = [], heartbeatAt = null, origin = 'desktop', messageId, jobId }) {
  const notes = (Array.isArray(events) ? events : [])
    .filter((event) => event && event.type === 'note')
    .slice(-LIVE_TURN_NOTE_LIMIT)
    .map((event) => ({ provider: event.provider ?? provider, text: event.text, redacted: event.redacted === true, at: event.at }))
  const times = [startedAt, heartbeatAt, ...notes.map((note) => note.at)]
    .map((value) => Date.parse(value ?? ''))
    .filter(Number.isFinite)
  const updatedAt = times.length ? new Date(Math.max(...times)).toISOString() : startedAt
  return portableLiveTurn({ turnId, status: 'running', provider, startedAt, updatedAt, origin, messageId, jobId, notes }) ?? null
}

/** Returns chats with the given `{ [chatId]: liveTurn }` applied (the writer's own runs win). */
export function withLiveTurns(chats, liveTurns, liveQueues = null) {
  const entries = record(liveTurns) ?? {}
  const queues = record(liveQueues) ?? {}
  if (!Object.keys(entries).length && !Object.keys(queues).length) return Array.isArray(chats) ? chats : []
  return (Array.isArray(chats) ? chats : []).map((chat) => {
    if (!chat) return chat
    const live = entries[chat.id]
    const queue = queues[chat.id]
    let next = live ? { ...chat, liveTurn: live } : chat
    if (queue) next = withLiveQueue(next, 'desktop', queue.items, queue.updatedAt)
    return next
  })
}

/** The desktop queue block for one chat's queued prompts (`{ messageId, turnId, enqueuedAt }`). */
export function desktopQueueBlock(prompts, heartbeatAt = null) {
  const items = (Array.isArray(prompts) ? prompts : [])
    .filter((prompt) => prompt && (prompt.messageId || prompt.turnId))
    .map((prompt) => ({
      ...(prompt.messageId ? { messageId: prompt.messageId } : {}),
      ...(prompt.turnId ? { turnId: prompt.turnId } : {}),
      ...(isoTime(prompt.enqueuedAt) ? { queuedAt: prompt.enqueuedAt } : {}),
    }))
  if (!items.length) return null
  const times = [heartbeatAt, ...items.map((item) => item.queuedAt)].map((value) => Date.parse(value ?? '')).filter(Number.isFinite)
  const updatedAt = times.length ? new Date(Math.max(...times)).toISOString() : null
  return updatedAt ? { updatedAt, items } : null
}

// ---- live queue (prompts waiting for the running turn) ---------------------
//
// `chat.liveQueue` lists prompts that are waiting for the conversation's
// running turn to end, per writer: `host` for phone turns Ensync Host holds,
// `desktop` for prompts a desktop window queued. Each writer replaces only its
// own block, the freshest block per writer wins, and an entry disappears once
// the transcript shows its turn ran.

const LIVE_QUEUE_ORIGINS = ['host', 'desktop']
const LIVE_QUEUE_LIMIT = 20

function portableQueueBlock(value) {
  const block = record(value)
  if (!block) return undefined
  const updatedAt = isoTime(block.updatedAt)
  if (!updatedAt) return undefined
  const items = (Array.isArray(block.items) ? block.items : [])
    .map((item) => {
      const entry = record(item)
      if (!entry) return null
      const messageId = liveIdentifier(entry.messageId)
      const turnId = liveIdentifier(entry.turnId)
      if (!messageId && !turnId) return null
      return {
        ...(messageId ? { messageId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(liveIdentifier(entry.jobId) ? { jobId: entry.jobId } : {}),
        ...(isoTime(entry.queuedAt) ? { queuedAt: entry.queuedAt } : {}),
      }
    })
    .filter(Boolean)
    .slice(0, LIVE_QUEUE_LIMIT)
  return { updatedAt, items }
}

export function portableLiveQueue(value) {
  const queue = record(value)
  if (!queue) return undefined
  const result = {}
  for (const origin of LIVE_QUEUE_ORIGINS) {
    const block = portableQueueBlock(queue[origin])
    if (block) result[origin] = block
  }
  return Object.keys(result).length ? result : undefined
}

function queueItemSettled(messages, item) {
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (!message) return false
    const sameTurn = (item.turnId && message.turnId === item.turnId)
      || (item.messageId && (message.id === item.messageId || message.turnId === item.messageId))
    return sameTurn && (message.role === 'agent' || SETTLED_DELIVERY_STATES.has(message.deliveryStatus))
  })
}

function settledLiveQueue(messages, queue, liveTurn) {
  if (!queue) return undefined
  const result = {}
  for (const origin of LIVE_QUEUE_ORIGINS) {
    const block = queue[origin]
    if (!block) continue
    const items = block.items.filter((item) => !queueItemSettled(messages, item)
      && !(liveTurn && ((item.turnId && item.turnId === liveTurn.turnId)
        || (item.messageId && (item.messageId === liveTurn.messageId || item.messageId === liveTurn.turnId)))))
    // An empty block is kept: it is how a writer says "nothing queued now".
    result[origin] = { ...block, items }
  }
  return Object.keys(result).length ? result : undefined
}

function mergeLiveQueue(local, remote) {
  const left = portableLiveQueue(local)
  const right = portableLiveQueue(remote)
  if (!left) return right
  if (!right) return left
  const result = {}
  for (const origin of LIVE_QUEUE_ORIGINS) {
    const a = left[origin]
    const b = right[origin]
    const chosen = !a ? b : !b ? a : Date.parse(a.updatedAt) >= Date.parse(b.updatedAt) ? a : b
    if (chosen) result[origin] = chosen
  }
  return Object.keys(result).length ? result : undefined
}

/**
 * Prompts of this chat that are waiting for its running turn, as
 * `{ messageId?, turnId?, jobId?, queuedAt?, origin }`, oldest first. Blocks a
 * writer stopped refreshing are ignored.
 */
export function activeQueuedTurns(chat, nowMs = Date.now()) {
  const queue = settledLiveQueue(chat?.messages, portableLiveQueue(chat?.liveQueue), activeLiveTurn(chat, nowMs))
  if (!queue) return []
  const items = []
  for (const origin of LIVE_QUEUE_ORIGINS) {
    const block = queue[origin]
    if (!block) continue
    if (Number.isFinite(nowMs) && nowMs - Date.parse(block.updatedAt) > LIVE_TURN_STALE_MS) continue
    items.push(...block.items.map((item) => ({ ...item, origin })))
  }
  return items
}

/** Replaces one writer's queue block on a chat. */
export function withLiveQueue(chat, origin, items, updatedAt) {
  const queue = { ...(portableLiveQueue(chat?.liveQueue) ?? {}), [origin]: { updatedAt, items } }
  return { ...chat, liveQueue: portableLiveQueue(queue) }
}

function portableContinuation(value) {
  const continuation = record(value)
  if (!continuation) return undefined
  return {
    ...continuation,
    executionTarget: 'not available on this device',
    sessionResumable: false,
    gitBefore: null,
    gitAfter: null,
    gitReason: 'Machine-local Git state is not synchronized between computers.',
  }
}

function portableChat(value) {
  const chat = record(value)
  if (!chat || !text(chat.id) || !text(chat.projectId)) return null
  const messages = Array.isArray(chat.messages)
    ? chat.messages.map(portableMessage).filter(Boolean)
    : []
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: text(chat.title, 'Conversation'),
    subtitle: text(chat.subtitle),
    group: ['Today', 'Yesterday', 'Previous 7 days'].includes(chat.group)
      ? chat.group
      : 'Previous 7 days',
    provider: text(chat.provider, 'codex'),
    providerMode: chat.providerMode === 'fixed' ? 'fixed' : 'auto',
    model: typeof chat.model === 'string' ? chat.model : null,
    sizeTier: typeof chat.sizeTier === 'string' ? chat.sizeTier : null,
    messages,
    ...(portableContinuation(chat.continuation)
      ? { continuation: portableContinuation(chat.continuation) }
      : {}),
    ...(chat.pinned === true ? { pinned: true } : {}),
    ...(liveTurnFor(messages, chat.liveTurn) ? { liveTurn: liveTurnFor(messages, chat.liveTurn) } : {}),
    ...(settledLiveQueue(messages, portableLiveQueue(chat.liveQueue), liveTurnFor(messages, chat.liveTurn))
      ? { liveQueue: settledLiveQueue(messages, portableLiveQueue(chat.liveQueue), liveTurnFor(messages, chat.liveTurn)) }
      : {}),
  }
}

function liveTurnFor(messages, value) {
  const live = portableLiveTurn(value)
  return live && !liveTurnSettled(messages, live) ? live : undefined
}

function portableProject(value) {
  const project = record(value)
  if (!project || !text(project.id) || !text(project.name)) return null
  return {
    id: project.id,
    name: project.name,
    // The encrypted document may retain a path hint so the same checkout can
    // be re-inspected. It is never treated as verified on another computer.
    path: text(project.path),
    host: project.host === 'local' ? 'local' : 'local',
    color: text(project.color),
  }
}

export function prepareAccountWorkspace(state) {
  const source = record(state) ?? {}
  return {
    format: ACCOUNT_WORKSPACE_FORMAT,
    version: ACCOUNT_WORKSPACE_VERSION,
    chats: (Array.isArray(source.chats) ? source.chats : []).map(portableChat).filter(Boolean),
    projects: (Array.isArray(source.projects) ? source.projects : []).map(portableProject).filter(Boolean),
  }
}

export function isAccountWorkspace(value) {
  const workspace = record(value)
  return Boolean(
    workspace
    && workspace.format === ACCOUNT_WORKSPACE_FORMAT
    && workspace.version === ACCOUNT_WORKSPACE_VERSION
    && Array.isArray(workspace.chats)
    && Array.isArray(workspace.projects),
  )
}

function messagePriority(message) {
  if (message?.deliveryStatus === 'interrupted' && message.handoffTransferred === true) {
    return DELIVERY_PRIORITY.transferred
  }
  return DELIVERY_PRIORITY[message?.deliveryStatus] ?? 0
}

const IN_FLIGHT_DELIVERY_STATES = new Set(['pending', 'queued'])

/**
 * The portable document cannot carry a running or queued prompt as runnable,
 * so `portableMessage` writes it as `interrupted`. When that copy merges back
 * into the device that is actually running (or queueing) the prompt, it must
 * not demote the live local state: only that device can interrupt its own run.
 */
function portableInterruptionOfLocalRun(remote, local) {
  return IN_FLIGHT_DELIVERY_STATES.has(local?.deliveryStatus)
    && remote?.deliveryStatus === 'interrupted'
    && remote.handoffTransferred !== true
}

function mergeMessage(authoritative, local) {
  if (portableInterruptionOfLocalRun(authoritative, local)) {
    const merged = { ...authoritative, ...local }
    delete merged.handoffTransferred
    if (Array.isArray(local.attachments)) merged.attachments = local.attachments
    return merged
  }
  const authoritativePriority = messagePriority(authoritative)
  const localPriority = messagePriority(local)
  const preferred = localPriority > authoritativePriority
    || (localPriority === authoritativePriority
      && Object.keys(local).length >= Object.keys(authoritative).length)
    ? local
    : authoritative
  const secondary = preferred === local ? authoritative : local
  const merged = { ...secondary, ...preferred }
  if (!(preferred.deliveryStatus === 'interrupted' && preferred.handoffTransferred === true)) {
    delete merged.handoffTransferred
  }
  // Attachment paths never come from the remote document, but the originating
  // computer must retain its richer local message after a sync merge.
  if (Array.isArray(local.attachments)) merged.attachments = local.attachments
  return merged
}

function appendMissingMessages(authoritative, incoming) {
  const result = authoritative.map((message) => ({ ...message }))
  const positions = new Map(result.map((message, index) => [message.id, index]))
  for (let index = 0; index < incoming.length; index += 1) {
    const message = incoming[index]
    const existingIndex = positions.get(message.id)
    if (existingIndex !== undefined) {
      result[existingIndex] = mergeMessage(result[existingIndex], message)
      continue
    }

    let insertionIndex = result.length
    for (let next = index + 1; next < incoming.length; next += 1) {
      const nextPosition = positions.get(incoming[next].id)
      if (nextPosition !== undefined) {
        insertionIndex = nextPosition
        break
      }
    }
    result.splice(insertionIndex, 0, { ...message })
    positions.clear()
    result.forEach((entry, position) => positions.set(entry.id, position))
  }
  return result
}

function mergeChat(local, remote) {
  const messages = appendMissingMessages(remote.messages ?? [], local.messages ?? [])
  const metadataSource = (local.messages?.length ?? 0) >= (remote.messages?.length ?? 0) ? local : remote
  // Progress is transient and never conflicts: the freshest copy wins, and it
  // disappears once the merged transcript shows the turn ended.
  const liveTurn = liveTurnFor(
    messages,
    newerLiveTurn(portableLiveTurn(local.liveTurn), portableLiveTurn(remote.liveTurn)),
  )
  const merged = {
    ...remote,
    ...local,
    ...metadataSource,
    messages,
    continuation: metadataSource.continuation ?? remote.continuation ?? local.continuation,
    ...(local.importSource ? { importSource: local.importSource } : {}),
  }
  if (liveTurn) merged.liveTurn = liveTurn
  else delete merged.liveTurn
  const liveQueue = settledLiveQueue(messages, mergeLiveQueue(local.liveQueue, remote.liveQueue), liveTurn)
  if (liveQueue) merged.liveQueue = liveQueue
  else delete merged.liveQueue
  return merged
}

function importedProject(project) {
  return {
    ...project,
    context: { ...EMPTY_PROJECT_CONTEXT },
    inspectedAt: '',
    verified: false,
  }
}

export function mergeAccountWorkspace(localState, remoteValue) {
  const local = record(localState) ?? {}
  const remote = isAccountWorkspace(remoteValue)
    ? prepareAccountWorkspace(remoteValue)
    : prepareAccountWorkspace({})

  const localChats = Array.isArray(local.chats) ? local.chats : []
  const remoteChats = remote.chats
  const localById = new Map(localChats.map((chat) => [chat.id, chat]))
  const remoteIds = new Set(remoteChats.map((chat) => chat.id))
  const chats = remoteChats.map((remoteChat) => {
    const localChat = localById.get(remoteChat.id)
    return localChat ? mergeChat(localChat, remoteChat) : remoteChat
  })
  for (const chat of localChats) {
    if (!remoteIds.has(chat.id)) chats.push(chat)
  }

  const localProjects = Array.isArray(local.projects) ? local.projects : []
  const projectById = new Map(localProjects.map((project) => [project.id, project]))
  const projects = remote.projects.map((remoteProject) => {
    const localProject = projectById.get(remoteProject.id)
    return localProject ?? importedProject(remoteProject)
  })
  const projectIds = new Set(projects.map((project) => project.id))
  for (const project of localProjects) {
    if (!projectIds.has(project.id)) projects.push(project)
  }

  return {
    state: {
      ...local,
      chats: chats.filter(Boolean),
      projects,
    },
    importedChats: remoteChats.filter((chat) => !localById.has(chat.id)).length,
    totalChats: chats.length,
  }
}

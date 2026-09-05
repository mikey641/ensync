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
  }
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

function mergeMessage(authoritative, local) {
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
  return {
    ...remote,
    ...local,
    ...metadataSource,
    messages,
    continuation: metadataSource.continuation ?? remote.continuation ?? local.continuation,
    ...(local.importSource ? { importSource: local.importSource } : {}),
  }
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

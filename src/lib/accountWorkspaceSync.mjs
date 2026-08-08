import { normalizeAgentUpdatePreferences } from './agentUpdatePreferences.mjs'
import { normalizeFallbackProviderOrder } from './automaticRouting.mjs'

export const ACCOUNT_WORKSPACE_FORMAT = 'ensync-account-conversations'
export const ACCOUNT_WORKSPACE_VERSION = 3

const EMPTY_PROJECT_CONTEXT = Object.freeze({
  relayDirectory: false,
  files: [],
  featureFiles: [],
  truncated: false,
  error: null,
  instructionAdapters: [],
})

const DELIVERY_PRIORITY = Object.freeze({
  queued: 0,
  pending: 1,
  failed: 2,
  interrupted: 3,
  cancelled: 4,
  completed: 5,
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
  return {
    ...message,
    content: text(message.content),
    time: text(message.time),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    // Local paths are never portable. The message text and attachment names
    // remain visible in the source workspace; another device cannot execute
    // or resolve the file reference.
    attachments: undefined,
    sessionResumable: message.sessionResumable === true,
  }
}

function portableContinuation(value) {
  const continuation = record(value)
  if (!continuation) return undefined
  return {
    ...continuation,
    sessionResumable: continuation.sessionResumable === true,
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

function portableSession(value) {
  const session = record(value)
  if (!session || !text(session.provider) || !text(session.sessionId)) return null
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    ...(text(session.targetKey) ? { targetKey: session.targetKey } : {}),
    ...(Number.isSafeInteger(session.syncedMessageCount) && session.syncedMessageCount >= 0
      ? { syncedMessageCount: session.syncedMessageCount }
      : {}),
  }
}

function portableInFlightRun(value) {
  const run = record(value)
  if (!run || !text(run.turnId) || !text(run.provider) || !text(run.jobId)) return null
  return {
    ...run,
    jobId: run.jobId,
    turnId: run.turnId,
    provider: run.provider,
    attemptedProviders: Array.isArray(run.attemptedProviders)
      ? run.attemptedProviders.filter((provider) => typeof provider === 'string')
      : [run.provider],
  }
}

function portableExecutionEvents(value) {
  const source = record(value) ?? {}
  return Object.fromEntries(Object.entries(source).flatMap(([chatId, events]) => {
    if (!text(chatId) || !Array.isArray(events)) return []
    const portable = events
      .filter((event) => record(event) && text(event.type))
      .slice(-500)
      .map((event) => ({ ...event }))
    return portable.length > 0 ? [[chatId, portable]] : []
  }))
}

function portableDisplayPreferences(value) {
  const preferences = record(value) ?? {}
  return {
    theme: ['system', 'light', 'dark'].includes(preferences.theme) ? preferences.theme : 'system',
    textSize: ['comfortable', 'large'].includes(preferences.textSize) ? preferences.textSize : 'large',
    completionIndicator: ['dot', 'header', 'tab'].includes(preferences.completionIndicator)
      ? preferences.completionIndicator
      : 'dot',
  }
}

function portableAccountSettings(value) {
  const source = record(value) ?? {}
  const settings = record(source.settings) ?? {}
  return {
    placement: (settings.placement ?? source.placement) === 'end' ? 'end' : 'adjacent',
    conversationLayout: (settings.conversationLayout ?? source.conversationLayout) === 'tabs' ? 'tabs' : 'split',
    autoFallback: typeof (settings.autoFallback ?? source.autoFallback) === 'boolean'
      ? settings.autoFallback ?? source.autoFallback
      : true,
    autoContextSkill: (settings.autoContextSkill ?? source.autoContextSkill) === true,
    fallbackProviderOrder: normalizeFallbackProviderOrder(
      settings.fallbackProviderOrder ?? source.fallbackProviderOrder,
    ),
    display: portableDisplayPreferences(settings.display ?? source.displayPreferences),
    agentUpdates: normalizeAgentUpdatePreferences(settings.agentUpdates ?? source.agentUpdatePreferences),
  }
}

export function prepareAccountWorkspace(state) {
  const source = record(state) ?? {}
  const inFlightRuns = Object.fromEntries(Object.entries(record(source.inFlightRuns) ?? {}).flatMap(([chatId, run]) => {
    const portable = portableInFlightRun(run)
    return text(chatId) && portable ? [[chatId, portable]] : []
  }))
  const chats = (Array.isArray(source.chats) ? source.chats : []).map(portableChat).filter(Boolean)
    .map((chat) => {
      const run = inFlightRuns[chat.id]
      return {
        ...chat,
        messages: chat.messages.map((message) => {
          if (message.deliveryStatus === 'queued') return { ...message, deliveryStatus: 'interrupted' }
          if (message.deliveryStatus !== 'pending') return message
          return run?.turnId === message.turnId
            ? message
            : { ...message, deliveryStatus: 'interrupted' }
        }),
      }
    })
  return {
    format: ACCOUNT_WORKSPACE_FORMAT,
    version: ACCOUNT_WORKSPACE_VERSION,
    chats,
    projects: (Array.isArray(source.projects) ? source.projects : []).map(portableProject).filter(Boolean),
    chatSessions: Object.fromEntries(Object.entries(record(source.chatSessions) ?? {}).flatMap(([chatId, session]) => {
      const portable = portableSession(session)
      return text(chatId) && portable ? [[chatId, portable]] : []
    })),
    inFlightRuns,
    chatExecutionEvents: portableExecutionEvents(source.chatExecutionEvents),
    settings: portableAccountSettings(source),
  }
}

export function isAccountWorkspace(value) {
  const workspace = record(value)
  return Boolean(
    workspace
    && workspace.format === ACCOUNT_WORKSPACE_FORMAT
    && [1, 2, ACCOUNT_WORKSPACE_VERSION].includes(workspace.version)
    && Array.isArray(workspace.chats)
    && Array.isArray(workspace.projects),
  )
}

export function accountWorkspaceHasSettings(value) {
  const workspace = record(value)
  return Boolean(isAccountWorkspace(workspace) && workspace.version >= 3 && record(workspace.settings))
}

function mergeSessions(localValue, remoteValue) {
  const local = record(localValue) ?? {}
  const remote = record(remoteValue) ?? {}
  const result = { ...remote }
  for (const [chatId, session] of Object.entries(local)) {
    const remoteSession = record(remote[chatId])
    const localCount = Number.isSafeInteger(session?.syncedMessageCount) ? session.syncedMessageCount : -1
    const remoteCount = Number.isSafeInteger(remoteSession?.syncedMessageCount) ? remoteSession.syncedMessageCount : -1
    if (!remoteSession || localCount >= remoteCount) result[chatId] = session
  }
  return result
}

function mergeExecutionEvents(localValue, remoteValue) {
  const local = record(localValue) ?? {}
  const remote = record(remoteValue) ?? {}
  const chatIds = new Set([...Object.keys(remote), ...Object.keys(local)])
  return Object.fromEntries([...chatIds].flatMap((chatId) => {
    const localEvents = Array.isArray(local[chatId]) ? local[chatId] : []
    const remoteEvents = Array.isArray(remote[chatId]) ? remote[chatId] : []
    const preferred = localEvents.length >= remoteEvents.length ? localEvents : remoteEvents
    return preferred.length > 0 ? [[chatId, preferred]] : []
  }))
}

function messagePriority(message) {
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

export function mergeAccountWorkspace(localState, remoteValue, options = {}) {
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

  const chatSessions = mergeSessions(local.chatSessions, remote.chatSessions)
  const candidateRuns = {
    ...(record(remote.inFlightRuns) ?? {}),
    ...(record(local.inFlightRuns) ?? {}),
  }
  const chatsById = new Map(chats.map((chat) => [chat.id, chat]))
  const inFlightRuns = Object.fromEntries(Object.entries(candidateRuns).filter(([chatId, run]) => {
    const turnId = record(run)?.turnId
    const chat = chatsById.get(chatId)
    return typeof turnId === 'string'
      && chat?.messages?.some((message) => message.turnId === turnId && message.deliveryStatus === 'pending')
  }))
  const chatExecutionEvents = mergeExecutionEvents(local.chatExecutionEvents, remote.chatExecutionEvents)
  const settings = accountWorkspaceHasSettings(remoteValue) && options.preferLocalSettings !== true
    ? remote.settings
    : portableAccountSettings(local)

  return {
    state: {
      ...local,
      chats: chats.filter(Boolean),
      projects,
      chatSessions,
      inFlightRuns,
      chatExecutionEvents,
      placement: settings.placement,
      conversationLayout: settings.conversationLayout,
      autoFallback: settings.autoFallback,
      autoContextSkill: settings.autoContextSkill,
      fallbackProviderOrder: settings.fallbackProviderOrder,
      displayPreferences: settings.display,
      agentUpdatePreferences: settings.agentUpdates,
    },
    importedChats: remoteChats.filter((chat) => !localById.has(chat.id)).length,
    totalChats: chats.length,
  }
}

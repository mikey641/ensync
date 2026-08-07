import {
  commitWorkspaceSnapshot,
  compactWorkspaceSnapshot,
  createWorkspaceSnapshotKeys,
  readWorkspaceSnapshot,
} from './workspacePersistence.mjs'
import {
  getNativeWorkspaceIdentity,
  workspaceStorageKey,
} from './nativeWorkspaceIdentity.mjs'

const SHA256_PATTERN = /^[0-9a-f]{64}$/i

function pathIdentity(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

function sameImport(left, right) {
  return left?.kind === 'codex_session'
    && right?.kind === 'codex_session'
    && left.sessionId === right.sessionId
    && pathIdentity(left.projectPath) === pathIdentity(right.projectPath)
}

function collisionSafeId(base, occupied, fingerprint) {
  if (!occupied.has(base)) return base
  let candidate = `${base}-import-${fingerprint.slice(0, 12)}`
  let suffix = 2
  while (occupied.has(candidate)) {
    candidate = `${base}-import-${fingerprint.slice(0, 12)}-${suffix}`
    suffix += 1
  }
  return candidate
}

function validCandidate(candidate) {
  return Boolean(
    candidate
    && SHA256_PATTERN.test(candidate.id)
    && candidate.project
    && typeof candidate.project.id === 'string'
    && typeof candidate.project.path === 'string'
    && candidate.chat
    && typeof candidate.chat.id === 'string'
    && Array.isArray(candidate.chat.messages)
    && candidate.chat.importSource
    && candidate.chat.importSource.sourceFingerprint === candidate.id
    && Array.isArray(candidate.chat.importSource.messageIds)
    && candidate.tab
    && candidate.tab.chatId === candidate.chat.id,
  )
}

function mergeImportedMessages(existing, incoming) {
  const existingSourceIds = new Set(existing.importSource?.messageIds ?? [])
  const incomingIds = new Set(incoming.importSource.messageIds)
  const nativeMessages = existing.messages.filter((message) => !existingSourceIds.has(message.id) && !incomingIds.has(message.id))
  const incomingById = new Map(incoming.messages.map((message) => [message.id, message]))
  const retainedOlderImported = existing.messages.filter((message) => existingSourceIds.has(message.id) && !incomingById.has(message.id))
  return [...incoming.messages, ...retainedOlderImported, ...nativeMessages]
}

/**
 * Merges one explicit external conversation. Existing workspace content wins
 * everywhere except the source-owned imported message prefix and active tab.
 */
export function mergeImportedConversationState(currentState, candidate) {
  if (!validCandidate(candidate)) throw new Error('Ensync received a malformed Codex conversation import.')
  const current = currentState && typeof currentState === 'object' ? currentState : {}
  const projects = [...(Array.isArray(current.projects) ? current.projects : [])]
  let project = projects.find((item) => pathIdentity(item.path) === pathIdentity(candidate.project.path))
  if (!project) {
    project = candidate.project
    projects.push(project)
  }

  const chats = [...(Array.isArray(current.chats) ? current.chats : [])]
  let chatIndex = chats.findIndex((item) => sameImport(item.importSource, candidate.chat.importSource))
  let chatId
  let addedChat = false
  let addedMessages = 0
  if (chatIndex >= 0) {
    const existing = chats[chatIndex]
    const mergedMessages = mergeImportedMessages(existing, candidate.chat)
    addedMessages = mergedMessages.filter((message) => !existing.messages.some((item) => item.id === message.id)).length
    chats[chatIndex] = {
      ...existing,
      subtitle: candidate.chat.subtitle,
      messages: mergedMessages,
      importSource: {
        ...candidate.chat.importSource,
        messageIds: [...new Set([...(candidate.chat.importSource.messageIds ?? []), ...(existing.importSource?.messageIds ?? [])])],
      },
    }
    chatId = existing.id
  } else {
    const occupied = new Set(chats.map((item) => item.id))
    chatId = collisionSafeId(candidate.chat.id, occupied, candidate.id)
    chats.push({ ...candidate.chat, id: chatId, projectId: project.id })
    chatIndex = chats.length - 1
    addedChat = true
    addedMessages = candidate.chat.messages.length
  }
  if (chats[chatIndex].projectId !== project.id) chats[chatIndex] = { ...chats[chatIndex], projectId: project.id }

  const tabs = [...(Array.isArray(current.tabs) ? current.tabs : [])]
  let tab = tabs.find((item) => item.chatId === chatId)
  let addedTab = false
  if (!tab) {
    const occupied = new Set(tabs.map((item) => item.id))
    const tabId = collisionSafeId(candidate.tab.id, occupied, candidate.id)
    tab = { ...candidate.tab, id: tabId, chatId }
    tabs.push(tab)
    addedTab = true
  }

  const latestAgentId = [...chats[chatIndex].messages].reverse().find((message) => message.role === 'agent')?.id
  const hiddenTabIds = (current.splitLayout?.hiddenTabIds ?? []).filter((id) => id !== tab.id)
  const applied = Array.isArray(current.conversationImportIds) ? current.conversationImportIds : []
  return {
    state: {
      ...current,
      projects,
      activeProjectId: project.id,
      chats,
      tabs,
      activeTabId: tab.id,
      readCompletionByChat: latestAgentId
        ? { ...(current.readCompletionByChat ?? {}), [chatId]: latestAgentId }
        : { ...(current.readCompletionByChat ?? {}) },
      splitLayout: current.splitLayout
        ? { ...current.splitLayout, hiddenTabIds }
        : current.splitLayout,
      conversationImportIds: [...new Set([...applied, candidate.id])].slice(-128),
    },
    summary: { addedChat, addedTab, addedMessages, chatId, tabId: tab.id },
  }
}

/** Applies only the candidate exposed to this shell-authenticated window. */
export async function initializeNativeConversationImport(target = globalThis) {
  const bridge = target?.ensyncDesktop
  if (typeof bridge?.getCodexConversationImport !== 'function') return { status: 'unavailable' }
  const candidate = await bridge.getCodexConversationImport()
  if (!candidate) return { status: 'unavailable' }

  const identity = getNativeWorkspaceIdentity()
  const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, identity))
  const currentSnapshot = readWorkspaceSnapshot(target.localStorage, { keys })
  const result = mergeImportedConversationState(currentSnapshot?.state ?? {}, candidate)
  const current = currentSnapshot?.state ?? {}
  const alreadyOpen = current.activeTabId === result.summary.tabId
    && Array.isArray(current.conversationImportIds)
    && current.conversationImportIds.includes(candidate.id)
    && result.summary.addedMessages === 0
    && !result.summary.addedChat
    && !result.summary.addedTab
  if (alreadyOpen) return { status: 'already_applied', summary: result.summary }

  const commit = commitWorkspaceSnapshot(target.localStorage, compactWorkspaceSnapshot(result.state), { keys })
  const verified = readWorkspaceSnapshot(target.localStorage, { keys })
  if (!verified?.state?.chats?.some((chat) => chat.id === result.summary.chatId)
    || verified.state.activeTabId !== result.summary.tabId) {
    throw new Error('The imported Codex conversation could not be verified in the v3 workspace snapshot.')
  }
  return { status: 'applied', summary: result.summary, commit }
}

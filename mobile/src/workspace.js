// Pure workspace-document helpers. Merging reuses the desktop's own
// `mergeAccountWorkspace`/`prepareAccountWorkspace`, so a phone edit lands with
// exactly the message-by-message semantics the desktop applies.

import {
  isAccountWorkspace,
  mergeAccountWorkspace,
  prepareAccountWorkspace,
} from '../../src/lib/accountWorkspaceSync.mjs'
import { resolveConversationWorkspaceKey } from '../../src/lib/conversationWorkspaceKey.mjs'

export { prepareAccountWorkspace, resolveConversationWorkspaceKey }

export function emptyWorkspace() {
  return prepareAccountWorkspace({})
}

/** Normalizes any decrypted document (or null) into a portable workspace. */
export function normalizeWorkspace(state) {
  return isAccountWorkspace(state) ? prepareAccountWorkspace(state) : emptyWorkspace()
}

/**
 * Applies pending phone edits on top of a document. Each op carries the chat it
 * touches (`chat`, used only when the document lacks it), an optional `project`
 * for a project that is new to the document, and the `message` to append.
 * Only the touched chats are merged, so a chat the desktop deleted is never
 * resurrected by the phone.
 */
export function applyPendingOps(workspace, ops) {
  const base = normalizeWorkspace(workspace)
  if (!ops?.length) return base
  const chats = new Map()
  const projects = new Map()
  for (const op of ops) {
    const existing = chats.get(op.chatId)
      ?? base.chats.find((chat) => chat.id === op.chatId)
      ?? op.chat
    if (!existing) continue
    const messages = existing.messages ?? []
    const next = { ...existing, messages: messages.some((message) => message.id === op.message.id) ? messages : [...messages, op.message] }
    chats.set(op.chatId, next)
    if (op.project && !base.projects.some((project) => project.id === op.project.id)) projects.set(op.project.id, op.project)
  }
  const merged = mergeAccountWorkspace({ chats: [...chats.values()], projects: [...projects.values()] }, base)
  return prepareAccountWorkspace(merged.state)
}

const STAMP = /(1\d{12})/

/** Best-effort epoch milliseconds for a message (phone `createdAt`, import `timestamp`, or an id stamp). */
export function messageTime(message) {
  for (const value of [message?.createdAt, message?.timestamp]) {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN
    if (Number.isFinite(parsed)) return parsed
  }
  const match = typeof message?.id === 'string' ? message.id.match(STAMP) : null
  return match ? Number(match[1]) : 0
}

export function chatActivity(chat) {
  let latest = 0
  for (const message of chat?.messages ?? []) latest = Math.max(latest, messageTime(message))
  if (!latest) {
    const match = typeof chat?.id === 'string' ? chat.id.match(STAMP) : null
    latest = match ? Number(match[1]) : 0
  }
  return latest
}

function projectKeyForPath(path) {
  return String(path).replace(/[\\/]+$/, '')
}

function basename(path) {
  const parts = projectKeyForPath(path).split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

/** Stable id for a Host recent project that is not yet in the workspace document. */
export function recentProjectId(path) {
  let hash = 0x811c9dc5
  for (const character of projectKeyForPath(path)) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `project-host-${hash.toString(36)}`
}

/**
 * Workspace projects ∪ the Host's recent projects (matched by path), newest
 * chat activity first. Projects without chats keep document order after them.
 */
export function listProjects(workspace, recentProjects = []) {
  const doc = normalizeWorkspace(workspace)
  const result = doc.projects.map((project, index) => ({ ...project, origin: 'workspace', index }))
  const paths = new Set(result.filter((project) => project.path).map((project) => projectKeyForPath(project.path)))
  for (const recent of Array.isArray(recentProjects) ? recentProjects : []) {
    if (!recent || typeof recent.path !== 'string' || !recent.path) continue
    const key = projectKeyForPath(recent.path)
    if (paths.has(key)) continue
    paths.add(key)
    result.push({
      id: recentProjectId(recent.path),
      name: typeof recent.name === 'string' && recent.name ? recent.name : basename(recent.path),
      path: recent.path,
      host: 'local',
      color: '',
      origin: 'host',
      index: result.length,
    })
  }
  for (const project of result) {
    const chats = doc.chats.filter((chat) => chat.projectId === project.id)
    project.chatCount = chats.length
    project.activity = chats.reduce((latest, chat) => Math.max(latest, chatActivity(chat)), 0)
  }
  return result.sort((left, right) => (right.activity - left.activity) || (left.index - right.index))
}

export function projectChats(workspace, projectId) {
  return normalizeWorkspace(workspace).chats
    .map((chat, index) => ({ chat, index, activity: chatActivity(chat) }))
    .filter((entry) => entry.chat.projectId === projectId)
    .sort((left, right) => (right.activity - left.activity) || (right.index - left.index))
    .map((entry) => entry.chat)
}

/** Portable project record for the document (drops the phone-only list fields). */
export function documentProject(project) {
  return { id: project.id, name: project.name, path: project.path ?? '', host: 'local', color: project.color ?? '' }
}

export function timeLabel(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function randomSuffix() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 10)
}

export function createUserMessage(content, provider, now = new Date()) {
  return {
    id: `msg-${now.getTime()}-phone-${randomSuffix()}`,
    role: 'user',
    content,
    time: timeLabel(now),
    createdAt: now.toISOString(),
    origin: 'phone',
    ...(provider ? { provider } : {}),
  }
}

export function titleFromPrompt(prompt) {
  const line = String(prompt).replace(/\s+/g, ' ').trim()
  if (!line) return 'New conversation'
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line
}

export function createChat({ projectId, provider, prompt, now = new Date() }) {
  return {
    id: `chat-${now.getTime()}-phone-${randomSuffix()}`,
    projectId,
    title: titleFromPrompt(prompt),
    subtitle: '',
    group: 'Today',
    provider,
    providerMode: 'fixed',
    model: null,
    sizeTier: null,
    messages: [],
  }
}

/**
 * The provider continuation session the Host recorded for this chat, if it
 * matches the provider being used. The Host writes `continuation.sessionId`
 * (plus `continuation.provider`) or a per-provider `continuation.sessions` map.
 */
export function continuationSessionId(chat, provider) {
  const continuation = chat?.continuation
  if (!continuation || typeof continuation !== 'object') return undefined
  const perProvider = continuation.sessions?.[provider]
  if (typeof perProvider === 'string' && perProvider) return perProvider
  if (typeof perProvider?.sessionId === 'string' && perProvider.sessionId) return perProvider.sessionId
  if (continuation.provider === provider && typeof continuation.sessionId === 'string' && continuation.sessionId) {
    return continuation.sessionId
  }
  return undefined
}

/** The broker run request for one phone turn, matching the desktop's workspace and session identity. */
export function turnRequest({ chat, project, provider, prompt, messageId, deliveryTarget }) {
  return {
    // Captured per prompt, like the desktop: Production (default) or Protected branch only.
    ...(deliveryTarget === 'protected_branch' ? { deliveryTarget } : { deliveryTarget: 'production' }),
    provider,
    projectPath: project.path,
    prompt,
    workspaceKey: resolveConversationWorkspaceKey(chat),
    sessionId: continuationSessionId(chat, provider),
    model: provider === chat.provider && typeof chat.model === 'string' ? chat.model : undefined,
    conversationId: chat.id,
    messageId,
  }
}

/** The agent reply that follows `messageId`, once the Host has written it into the document. */
export function replyAfter(chat, messageId) {
  const messages = chat?.messages ?? []
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return null
  return messages.slice(index + 1).find((message) => message.role === 'agent') ?? null
}

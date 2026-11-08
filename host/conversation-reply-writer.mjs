import { AccountSyncError } from './account-sync.mjs'
import { mergeAccountWorkspace, prepareAccountWorkspace } from './account-workspace.mjs'
import { extractEnsyncContinuation } from './ensync-continuation.mjs'

const MAX_CONVERSATION_ID_CHARACTERS = 480
const MAX_MESSAGE_ID_CHARACTERS = 200
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MAX_PUSH_ATTEMPTS = 5
const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000, 600_000]

function boundedIdentifier(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !CONTROL_CHARACTERS.test(value)
}

/**
 * Validates and separates the optional conversation identity a phone attaches
 * to a brokered chat request. The identity is Host bookkeeping only: the
 * returned `request` never carries it, so it cannot reach a provider CLI.
 */
export function splitConversationIdentity(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { request, conversation: null }
  }
  const { conversationId, messageId, ...rest } = request
  if (conversationId == null && messageId == null) return { request: rest, conversation: null }
  if (!boundedIdentifier(conversationId, MAX_CONVERSATION_ID_CHARACTERS)) {
    throw new AccountSyncError('invalid_conversation_id', 'The conversation ID is invalid.', 400)
  }
  if (messageId != null && !boundedIdentifier(messageId, MAX_MESSAGE_ID_CHARACTERS)) {
    throw new AccountSyncError('invalid_message_id', 'The message ID is invalid.', 400)
  }
  return { request: rest, conversation: { conversationId, messageId: messageId ?? null } }
}

function clockTime(date) {
  try {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return date.toISOString().slice(11, 16)
  }
}

/**
 * Applies one finished brokered turn to the chat it belongs to. Returns the
 * updated chat, `null` when the chat is not in the document yet, or the
 * string `'unchanged'` when the reply is already recorded.
 *
 * Message shapes mirror what the desktop renderer writes after a local run, so
 * the desktop tab renders the phone turn exactly like one it ran itself.
 */
export function applyBrokeredTurn(document, input) {
  const workspace = prepareAccountWorkspace(document ?? {})
  const chat = workspace.chats.find((item) => item.id === input.conversationId)
  if (!chat) return null
  const now = input.now ?? new Date()
  const completedAt = now.toISOString()
  const agentMessageId = `msg-${input.jobId}-agent`
  const messages = chat.messages.map((message) => ({ ...message }))
  const userIndex = input.messageId ? messages.findIndex((message) => message.id === input.messageId) : -1
  const userMessage = userIndex >= 0 ? messages[userIndex] : null
  const turnId = typeof userMessage?.turnId === 'string' && userMessage.turnId
    ? userMessage.turnId
    : (input.messageId ?? input.jobId)
  const outcome = input.outcome
  const deliveryStatus = outcome.type === 'completed'
    ? 'completed'
    : outcome.type === 'cancelled' ? 'cancelled' : 'failed'

  const alreadyReplied = messages.some((message) => message.id === agentMessageId)
  if (alreadyReplied && (!userMessage || userMessage.deliveryStatus === deliveryStatus)) return 'unchanged'
  if (userMessage) messages[userIndex] = { ...userMessage, deliveryStatus }

  const provider = typeof outcome.result?.provider === 'string' ? outcome.result.provider : input.request?.provider ?? chat.provider
  const sessionId = typeof outcome.result?.sessionId === 'string' && outcome.result.sessionId
    ? outcome.result.sessionId
    : null
  const workspaceRef = outcome.result?.workspace && typeof outcome.result.workspace === 'object'
    ? { path: outcome.result.workspace.path ?? null, branch: outcome.result.workspace.branch ?? null }
    : null

  let continuation
  if (outcome.type === 'completed') {
    const extracted = extractEnsyncContinuation(typeof outcome.result?.response === 'string' ? outcome.result.response : '')
    if (!alreadyReplied) {
      const agentMessage = {
        id: agentMessageId,
        role: 'agent',
        turnId,
        provider,
        model: typeof outcome.result?.model === 'string' ? outcome.result.model : null,
        sizeTier: null,
        executionTarget: 'local',
        sessionResumable: Boolean(sessionId),
        content: extracted.visibleResponse,
        time: clockTime(now),
        createdAt: completedAt,
        origin: 'host',
        jobId: input.jobId,
      }
      // The reply belongs directly after the user turn it answers, ahead of any
      // later messages that were queued meanwhile.
      const insertAt = userIndex >= 0 ? userIndex + 1 : messages.length
      messages.splice(insertAt, 0, agentMessage)
    }
    continuation = {
      turnId,
      status: 'completed',
      provider,
      model: typeof outcome.result?.model === 'string' ? outcome.result.model : null,
      sizeTier: null,
      executionTarget: 'local',
      sessionResumable: Boolean(sessionId),
      sessionId,
      workspaceKey: typeof input.request?.workspaceKey === 'string' ? input.request.workspaceKey : null,
      attemptedProviders: [provider],
      fallbackReason: null,
      completedAt: typeof outcome.result?.completedAt === 'string' ? outcome.result.completedAt : completedAt,
      workspace: workspaceRef,
      gitBefore: null,
      gitAfter: null,
      gitReason: null,
      semanticSummary: extracted.semanticSummary,
    }
  } else {
    continuation = {
      turnId,
      status: outcome.type === 'cancelled' ? 'cancelled' : outcome.reconciliationRequired ? 'reconciliation_required' : 'blocked',
      provider,
      model: null,
      sizeTier: null,
      executionTarget: 'local',
      sessionResumable: false,
      sessionId: null,
      workspaceKey: typeof input.request?.workspaceKey === 'string' ? input.request.workspaceKey : null,
      attemptedProviders: [provider],
      fallbackReason: typeof outcome.message === 'string' ? outcome.message : null,
      completedAt,
      gitBefore: null,
      gitAfter: null,
      gitReason: null,
      semanticSummary: null,
      ...(outcome.reconciliationRequired ? { reconciliationRequired: true } : {}),
    }
  }

  return {
    ...chat,
    subtitle: outcome.type === 'completed' ? 'Updated just now' : outcome.type === 'cancelled' ? 'Stopped by you' : 'Run failed',
    messages,
    continuation,
  }
}

/** Normalizes a ChatJobService terminal event into a reply outcome. */
export function outcomeFromTerminalEvent(event) {
  if (event?.type === 'completed') return { type: 'completed', result: event.result ?? null }
  if (event?.type === 'cancelled') return { type: 'cancelled', message: event.message ?? 'The run was stopped.' }
  return {
    type: 'failed',
    message: typeof event?.error === 'string' ? event.error : (event?.message ?? 'The Ensync Host run failed.'),
    reconciliationRequired: ['host_job_orphaned', 'broker_job_reconciliation_required'].includes(event?.code),
  }
}

/**
 * Durably appends brokered replies to the encrypted account workspace: pull,
 * merge with the same rules the desktop uses, push with the base revision, and
 * re-merge on conflict. Failed writes retry with backoff so a reply survives a
 * brief Sync outage while the phone is closed.
 */
export class ConversationReplyWriter {
  #accountSync
  #retryDelaysMs
  #log
  #queue = []
  #draining = null
  #timer = null

  constructor(options = {}) {
    if (!options.accountSyncService) throw new TypeError('An account sync service is required.')
    this.#accountSync = options.accountSyncService
    this.#retryDelaysMs = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS
    this.#log = typeof options.log === 'function' ? options.log : () => {}
    this.lastError = null
  }

  pendingCount() {
    return this.#queue.length
  }

  enqueue(input) {
    this.#queue.push({ ...input, attempts: 0 })
    return this.drain()
  }

  drain() {
    if (this.#draining) return this.#draining
    this.#draining = (async () => {
      while (this.#queue.length) {
        const item = this.#queue[0]
        try {
          await this.write(item)
          this.#queue.shift()
          this.lastError = null
        } catch (error) {
          item.attempts += 1
          this.lastError = { code: error?.code ?? 'conversation_write_failed', message: error?.message ?? 'Could not save the reply.' }
          this.#queue.shift()
          const delay = this.#retryDelaysMs[item.attempts - 1]
          if (delay === undefined) {
            this.#log(`dropping brokered reply for ${item.conversationId} after ${item.attempts} attempts: ${this.lastError.message}`)
            continue
          }
          this.#scheduleRetry(item, delay)
        }
      }
    })().finally(() => { this.#draining = null })
    return this.#draining
  }

  stop() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #scheduleRetry(item, delay) {
    const timer = setTimeout(() => {
      this.#queue.push(item)
      void this.drain()
    }, delay)
    timer.unref?.()
    this.#timer = timer
  }

  /** One pull → apply → merge → push cycle with bounded conflict retries. */
  async write(input) {
    if (!this.#accountSync.status().authenticated) {
      throw new AccountSyncError('sync_login_required', 'Sign in to save the reply to your account.', 401)
    }
    const pulled = await this.#accountSync.pull()
    let remoteState = pulled.state
    let revision = pulled.revision
    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt += 1) {
      const chat = applyBrokeredTurn(remoteState, input)
      if (chat === 'unchanged') return { status: 'unchanged', revision }
      if (!chat) {
        throw new AccountSyncError('conversation_not_found', 'The conversation is not in the synchronized workspace yet.', 404)
      }
      const merged = mergeAccountWorkspace({ chats: [chat], projects: [] }, remoteState)
      const document = prepareAccountWorkspace(merged.state)
      const pushed = await this.#accountSync.push(document, revision)
      if (pushed.status === 'saved') return { status: 'saved', revision: pushed.revision }
      remoteState = pushed.remoteState
      revision = pushed.revision
    }
    throw new AccountSyncError('sync_revision_conflict', 'The synchronized workspace kept changing while saving the reply.', 409)
  }
}

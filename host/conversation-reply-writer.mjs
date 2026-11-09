import { AccountSyncError } from './account-sync.mjs'
import {
  buildLiveTurn,
  LIVE_TURN_NOTE_LIMIT,
  liveTurnSettled,
  mergeAccountWorkspace,
  withLiveQueue,
  prepareAccountWorkspace,
} from './account-workspace.mjs'
import { extractEnsyncContinuation } from './ensync-continuation.mjs'

const MAX_CONVERSATION_ID_CHARACTERS = 480
const MAX_MESSAGE_ID_CHARACTERS = 200
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MAX_PUSH_ATTEMPTS = 5
const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000, 600_000]
const DEFAULT_PROGRESS_INTERVAL_MS = 1_500
const MAX_PROGRESS_PUSH_ATTEMPTS = 3

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

  if (input.transferredTo) {
    // Delivered into the running turn as a live instruction: that turn's reply
    // answers it, so it gets no reply or continuation of its own.
    if (!userMessage) return 'unchanged'
    if (userMessage.steeredInto === input.transferredTo) return 'unchanged'
    messages[userIndex] = { ...userMessage, steeredInto: input.transferredTo }
    return { ...chat, messages }
  }

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
        ...(keptNotes(input.notes, provider).length ? { notes: keptNotes(input.notes, provider) } : {}),
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

  // The turn is over, so its transient progress goes with it.
  const settledChat = { ...chat }
  delete settledChat.liveTurn
  if (input.neverStarted === true) {
    // A queued turn that was stopped or rejected before it ran never touched
    // the conversation's workspace or session, so the chat's continuation
    // (which may describe a turn still running on the desktop) stays as is.
    return { ...settledChat, messages }
  }
  return {
    ...settledChat,
    subtitle: outcome.type === 'completed' ? 'Updated just now' : outcome.type === 'cancelled' ? 'Stopped by you' : 'Run failed',
    messages,
    continuation,
  }
}

/**
 * Replaces the Host's queue block on a chat: the phone turns that wait for
 * the conversation's running turn. Returns the chat, `null` when missing, or
 * `'unchanged'`.
 */
export function applyHostQueue(document, input) {
  const workspace = prepareAccountWorkspace(document ?? {})
  const chat = workspace.chats.find((item) => item.id === input.conversationId)
  if (!chat) return null
  const items = (Array.isArray(input.items) ? input.items : []).map((item) => ({
    ...(item.messageId ? { messageId: item.messageId } : {}),
    ...(item.jobId ? { jobId: item.jobId } : {}),
    ...(item.queuedAt ? { queuedAt: item.queuedAt } : {}),
  }))
  const current = chat.liveQueue?.host
  if (!current && !items.length) return 'unchanged'
  const next = withLiveQueue(chat, 'host', items, input.heartbeatAt ?? new Date().toISOString())
  const normalized = prepareAccountWorkspace({ chats: [next], projects: [] }).chats[0]
  if (JSON.stringify(current?.items ?? []) === JSON.stringify(normalized.liveQueue?.host?.items ?? [])
    && current?.updatedAt === normalized.liveQueue?.host?.updatedAt) return 'unchanged'
  return next
}

/** The desktop keeps a finished turn's last notes on its reply; mirror that shape. */
function keptNotes(notes, provider) {
  return (Array.isArray(notes) ? notes : [])
    .filter((note) => note && typeof note.text === 'string' && note.text.trim())
    .slice(-LIVE_TURN_NOTE_LIMIT)
    .map((note) => ({ provider: typeof note.provider === 'string' ? note.provider : provider, text: note.text, redacted: note.redacted === true }))
}

/**
 * Applies the live progress of a brokered turn that is still running. Returns
 * the updated chat, `null` when the chat is missing, or `'unchanged'` when the
 * turn already finished (its reply or terminal status is in the transcript) or
 * the document already holds this exact progress.
 */
export function applyBrokeredProgress(document, input) {
  const workspace = prepareAccountWorkspace(document ?? {})
  const chat = workspace.chats.find((item) => item.id === input.conversationId)
  if (!chat) return null
  const userMessage = input.messageId ? chat.messages.find((message) => message.id === input.messageId) : null
  const turnId = typeof userMessage?.turnId === 'string' && userMessage.turnId
    ? userMessage.turnId
    : (input.messageId ?? input.jobId)
  const liveTurn = buildLiveTurn({
    turnId,
    provider: input.provider ?? chat.provider,
    startedAt: input.startedAt,
    events: (input.notes ?? []).map((note) => ({ ...note, type: 'note' })),
    heartbeatAt: input.heartbeatAt ?? null,
    origin: 'host',
    ...(input.messageId ? { messageId: input.messageId } : {}),
    jobId: input.jobId,
  })
  if (!liveTurn || liveTurnSettled(chat.messages, liveTurn)) return 'unchanged'
  if (JSON.stringify(chat.liveTurn ?? null) === JSON.stringify(liveTurn)) return 'unchanged'
  return { ...chat, liveTurn }
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
  #progressIntervalMs
  #progress = new Map()
  #finishedJobs = new Set()
  #progressTimer = null
  #progressWriting = null
  #queueUpdates = new Map()

  constructor(options = {}) {
    if (!options.accountSyncService) throw new TypeError('An account sync service is required.')
    this.#accountSync = options.accountSyncService
    this.#retryDelaysMs = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS
    this.#log = typeof options.log === 'function' ? options.log : () => {}
    this.#progressIntervalMs = Number.isFinite(options.progressIntervalMs)
      ? Math.max(0, options.progressIntervalMs)
      : DEFAULT_PROGRESS_INTERVAL_MS
    this.lastError = null
  }

  /**
   * Records the latest live progress of a running brokered turn and publishes
   * it at most once per progress interval. Progress is transient: only the
   * newest snapshot per conversation is kept, failures are not retried, and a
   * turn whose reply was already enqueued never publishes again.
   */
  publishProgress(input) {
    if (!input?.conversationId || !input.jobId || this.#finishedJobs.has(input.jobId)) return Promise.resolve()
    this.#progress.set(input.conversationId, { ...input })
    this.#wakeProgress()
    return Promise.resolve()
  }

  /** Mirrors the Host's queue for one conversation (throttled like progress). */
  publishQueue(input) {
    if (!input?.conversationId) return Promise.resolve()
    this.#queueUpdates.set(input.conversationId, { ...input })
    this.#wakeProgress()
    return Promise.resolve()
  }

  #wakeProgress() {
    if (!this.#progressTimer && !this.#progressWriting) this.#scheduleProgress(this.#progressIntervalMs)
  }

  #scheduleProgress(delay) {
    const timer = setTimeout(() => {
      this.#progressTimer = null
      this.#progressWriting = this.#flushProgress().finally(() => {
        this.#progressWriting = null
        if (this.#progress.size || this.#queueUpdates.size) this.#scheduleProgress(this.#progressIntervalMs)
      })
    }, delay)
    timer.unref?.()
    this.#progressTimer = timer
  }

  /** Writes every pending progress snapshot now (exposed for tests). */
  async flushProgress() {
    if (this.#progressTimer) clearTimeout(this.#progressTimer)
    this.#progressTimer = null
    await this.#progressWriting
    await this.#flushProgress()
  }

  async #flushProgress() {
    const queues = [...this.#queueUpdates.values()]
    this.#queueUpdates.clear()
    for (const item of queues) {
      try {
        await this.#writeTransient((state) => applyHostQueue(state, item))
      } catch (error) {
        this.#log(`queue state for ${item.conversationId} was not saved: ${error?.message ?? error}`)
      }
    }
    const pending = [...this.#progress.values()]
    this.#progress.clear()
    for (const item of pending) {
      if (this.#finishedJobs.has(item.jobId)) continue
      try {
        await this.writeProgress(item)
      } catch (error) {
        this.#log(`live progress for ${item.conversationId} was not saved: ${error?.message ?? error}`)
      }
    }
  }

  /** One pull → apply progress → merge → push cycle; conflicts re-merge a few times. */
  async writeProgress(input) {
    return this.#writeTransient((state) => (
      this.#finishedJobs.has(input.jobId) ? 'unchanged' : applyBrokeredProgress(state, input)
    ))
  }

  async #writeTransient(apply) {
    if (!this.#accountSync.status().authenticated) return { status: 'skipped' }
    const pulled = await this.#accountSync.pull()
    let remoteState = pulled.state
    let revision = pulled.revision
    for (let attempt = 0; attempt < MAX_PROGRESS_PUSH_ATTEMPTS; attempt += 1) {
      const chat = apply(remoteState)
      if (chat === 'unchanged' || !chat) return { status: 'unchanged', revision }
      const merged = mergeAccountWorkspace({ chats: [chat], projects: [] }, remoteState)
      const pushed = await this.#accountSync.push(prepareAccountWorkspace(merged.state), revision)
      if (pushed.status === 'saved') return { status: 'saved', revision: pushed.revision }
      remoteState = pushed.remoteState
      revision = pushed.revision
    }
    return { status: 'conflict', revision }
  }

  pendingCount() {
    return this.#queue.length
  }

  enqueue(input) {
    if (input?.jobId) {
      this.#finishedJobs.add(input.jobId)
      if (this.#finishedJobs.size > 500) this.#finishedJobs.delete(this.#finishedJobs.values().next().value)
      const pending = this.#progress.get(input.conversationId)
      if (pending?.jobId === input.jobId) this.#progress.delete(input.conversationId)
    }
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
    if (this.#progressTimer) clearTimeout(this.#progressTimer)
    this.#progressTimer = null
    this.#progress.clear()
    this.#queueUpdates.clear()
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

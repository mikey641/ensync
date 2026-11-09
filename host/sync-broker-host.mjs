import { AccountSyncError } from './account-sync.mjs'
import { ChatJobError } from './chat-jobs.mjs'
import { LIVE_TURN_HEARTBEAT_MS, LIVE_TURN_NOTE_LIMIT } from './account-workspace.mjs'
import { splitConversationIdentity } from './conversation-reply-writer.mjs'
import { conversationBranchName } from './project-isolation.mjs'

const DEFAULT_POLL_INTERVAL_MS = 1_000
const MAX_DELIVERY_RECORDS = 5
const MAX_DELIVERY_TEXT = 300

function workspaceIdentity(request) {
  return JSON.stringify([request?.projectPath ?? '', request?.workspaceKey ?? ''])
}

function boundedText(value) {
  if (typeof value !== 'string' || !value) return null
  return value.length > MAX_DELIVERY_TEXT ? `${value.slice(0, MAX_DELIVERY_TEXT - 1)}…` : value
}

function shortSha(value) {
  return typeof value === 'string' && value ? value.slice(0, 12) : null
}

function boundedDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object') return null
  return { status: typeof delivery.status === 'string' ? delivery.status : null }
}

/**
 * The delivery facts a phone may see for one conversation branch: state,
 * target, short SHAs, description and deployment URL. Raw logs, credentials
 * and project paths stay on the Host.
 */
export function summarizeDelivery(status, branch) {
  if (!status || typeof status !== 'object') return null
  const all = [
    ...(Array.isArray(status.records) ? status.records : []),
    status.current, status.production, status.pending,
  ].filter((record) => record && typeof record.id === 'string')
  const seen = new Set()
  const records = all
    .filter((record) => {
      if (seen.has(record.id)) return false
      seen.add(record.id)
      return !branch || (Array.isArray(record.sourceBranches) && record.sourceBranches.includes(branch))
    })
    .sort((left, right) => (Date.parse(right.updatedAt ?? right.createdAt ?? '') || 0) - (Date.parse(left.updatedAt ?? left.createdAt ?? '') || 0))
    .slice(0, MAX_DELIVERY_RECORDS)
    .map((record) => ({
      id: record.id,
      state: typeof record.state === 'string' ? record.state : null,
      landingState: typeof record.landingState === 'string' ? record.landingState : null,
      deliveryTarget: record.deliveryTarget === 'protected_branch' ? 'protected_branch' : 'production',
      description: boundedText(record.description),
      targetBranch: boundedText(record.targetBranch),
      savedSha: shortSha(record.savedSha),
      productionCommitSha: shortSha(record.replacementCommitSha ?? record.productionCommitSha),
      deploymentUrl: typeof record.deploymentUrl === 'string' && record.deploymentUrl.startsWith('https://') ? boundedText(record.deploymentUrl) : null,
      failureMessage: boundedText(record.failureMessage ?? record.landingError),
      repairState: typeof record.repairState === 'string' ? record.repairState : null,
      turnIds: Array.isArray(record.turnIds) ? record.turnIds.filter((id) => typeof id === 'string').slice(0, 10) : [],
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    }))
  return { branch, records }
}

function errorPayload(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'sync_broker_host_error',
    message: error instanceof Error ? error.message : 'Unexpected brokered Host error.',
    status: Number.isInteger(error?.status) ? error.status : 500,
    safeToRetry: error?.safeToRetry === true,
  }
}

function publicStatus(worker) {
  return {
    state: worker.running ? worker.lastError ? 'degraded' : 'connected' : 'disconnected',
    running: worker.running,
    host: worker.host ? { ...worker.host } : null,
    lastPollAt: worker.lastPollAt,
    lastError: worker.lastError,
    activeJobs: worker.trackers.size,
    transport: 'outbound_https_poll',
    encryption: 'aes-256-gcm',
  }
}

/**
 * Maintains an outbound-only broker connection. Sync can redeliver opaque jobs,
 * but ChatJobService remains the execution authority and rejects a reused job ID
 * with different request bytes before any provider process starts.
 */
export class SyncBrokerHostWorker {
  constructor(options = {}) {
    if (!options.accountSyncService || !options.chatJobService) {
      throw new TypeError('Account sync and chat-job services are required for brokered Host execution.')
    }
    this.account = options.accountSyncService
    this.chatJobs = options.chatJobService
    // Called once per finished brokered job that names a conversation, so the
    // Host can append the reply to the encrypted workspace document.
    this.onConversationJobFinished = typeof options.onConversationJobFinished === 'function'
      ? options.onConversationJobFinished
      : null
    // Called while a brokered conversation job runs (start, each provider note,
    // and a periodic heartbeat) so the Host can mirror its live progress into
    // the encrypted workspace document. Only notes are forwarded, never output.
    this.onConversationJobProgress = typeof options.onConversationJobProgress === 'function'
      ? options.onConversationJobProgress
      : null
    // Called whenever the Host-side queue for a conversation changes (a phone
    // turn waits for the running turn in that conversation to finish).
    this.onConversationQueueChanged = typeof options.onConversationQueueChanged === 'function'
      ? options.onConversationQueueChanged
      : null
    // Bounded delivery status for a project branch (Host delivery coordinator).
    this.deliveryStatus = typeof options.deliveryStatus === 'function' ? options.deliveryStatus : null
    this.queueReportedAt = new Map()
    this.liveHeartbeatMs = Number.isFinite(options.liveHeartbeatMs)
      ? Math.max(1_000, options.liveHeartbeatMs)
      : LIVE_TURN_HEARTBEAT_MS
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs)
      ? Math.max(50, options.pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS
    this.running = false
    this.host = null
    this.lastPollAt = null
    this.lastError = null
    this.trackers = new Map()
    this.timer = null
    this.polling = null
  }

  status() {
    return publicStatus(this)
  }

  async connect(input) {
    if (this.running) await this.stop()
    this.host = await this.account.registerBrokerDevice({ ...input, role: 'host' })
    this.running = true
    this.lastError = null
    this.#schedule(0)
    return this.status()
  }

  createPairing() {
    if (!this.running) {
      throw new AccountSyncError('sync_broker_host_disconnected', 'Connect this Ensync Host before pairing a remote client.', 409)
    }
    return this.account.createBrokerPairing()
  }

  async disconnect(options = {}) {
    await this.stop()
    if (options.revoke === true && this.host) await this.account.revokeBrokerDevice()
    this.host = null
    return this.status()
  }

  async stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.polling?.catch(() => {})
    for (const tracker of this.trackers.values()) tracker.dispose?.()
    this.trackers.clear()
    return this.status()
  }

  async pollOnce() {
    if (!this.running) {
      throw new AccountSyncError('sync_broker_host_disconnected', 'The brokered Host connection is not running.', 409)
    }
    if (this.polling) return this.polling
    this.polling = this.#poll().finally(() => { this.polling = null })
    return this.polling
  }

  #schedule(delay = this.pollIntervalMs) {
    if (!this.running || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pollOnce()
        .catch(() => {})
        .finally(() => this.#schedule())
    }, delay)
    this.timer.unref?.()
  }

  async #poll() {
    try {
      for (const tracker of this.trackers.values()) {
        await this.#processCommands(tracker)
        if (tracker.waiting) await this.#admitWaiting(tracker)
        await this.#flushEvents(tracker)
        if (!tracker.ended && !tracker.waiting && tracker.progressAt && Date.now() - tracker.progressAt >= this.liveHeartbeatMs) {
          this.#reportProgress(tracker)
        }
        this.#retireTracker(tracker)
      }
      this.#heartbeatQueues()
      const jobs = await this.account.pollBrokerHostJobs()
      this.lastPollAt = new Date().toISOString()
      this.lastError = null
      for (const job of jobs) {
        const tracker = this.trackers.get(job.id) ?? await this.#attach(job)
        tracker.job = { ...tracker.job, ...job }
        await this.#flushEvents(tracker)
        await this.#processCommands(tracker)
        this.#retireTracker(tracker)
      }
      return this.status()
    } catch (error) {
      this.lastPollAt = new Date().toISOString()
      this.lastError = errorPayload(error)
      throw error
    }
  }

  async #attach(job) {
    let claimed = job
    let existing = null
    try {
      existing = this.chatJobs.get(job.id)
    } catch (error) {
      if (!(error instanceof ChatJobError) || error.code !== 'chat_job_not_found') throw error
    }

    if (!existing) {
      claimed = await this.account.claimBrokerJob(job)
      if (!claimed.newlyClaimed) {
        return this.#reconcileMissingJob(claimed)
      }
    }

    let identity
    try {
      // conversationId/messageId are Host bookkeeping; the chat job (and so the
      // provider CLI) only ever sees the remaining request fields.
      identity = splitConversationIdentity(claimed.request)
    } catch (error) {
      return this.#rejectClaimedJob(claimed, error)
    }

    if (identity.request?.control !== undefined) return this.#runControl(claimed, identity)

    const tracker = {
      job: claimed,
      localJob: null,
      pendingEvents: [],
      pendingSequences: new Set(),
      lastCommandSequence: 0,
      processedCommands: new Map(),
      ended: false,
      flushing: null,
      dispose: null,
      conversation: identity.conversation,
      request: identity.request,
      terminalEvent: null,
      startedAt: null,
      notes: [],
      progressAt: 0,
      waiting: null,
    }
    this.trackers.set(claimed.id, tracker)
    await this.#startTracker(tracker)
    return tracker
  }

  /**
   * Starts (or, while the conversation is busy, queues) the chat job of a
   * claimed brokered turn. A turn for a conversation whose workspace is
   * already running waits, exactly like a prompt sent from the desktop while a
   * turn runs, and starts on its own once that turn ends.
   */
  async #startTracker(tracker) {
    let admission
    try {
      // start() is also the request-hash assertion for a retained job. When the
      // ID is new, the broker claim above was durably recorded first.
      admission = await this.chatJobs.start({
        jobId: tracker.job.id,
        kind: tracker.job.kind,
        request: tracker.request,
      })
    } catch (error) {
      this.#failTracker(tracker, error)
      return
    }
    if (admission.disposition === 'occupied') {
      if (!tracker.waiting) {
        tracker.waiting = { since: new Date().toISOString(), ownerJobId: admission.owner?.jobId ?? null }
        this.#reportQueue(tracker.conversation?.conversationId)
      } else {
        tracker.waiting.ownerJobId = admission.owner?.jobId ?? tracker.waiting.ownerJobId
      }
      return
    }
    const wasWaiting = Boolean(tracker.waiting)
    tracker.waiting = null
    if (wasWaiting) this.#reportQueue(tracker.conversation?.conversationId)
    this.#subscribe(tracker, admission.job)
  }

  /** Retries a queued turn; only the oldest queued turn per workspace tries. */
  async #admitWaiting(tracker) {
    const key = workspaceIdentity(tracker.request)
    for (const candidate of this.trackers.values()) {
      if (candidate === tracker) break
      if (candidate.waiting && !candidate.ended && workspaceIdentity(candidate.request) === key) return
    }
    await this.#startTracker(tracker)
  }

  #subscribe(tracker, localJob) {
    tracker.localJob = localJob
    tracker.ended = localJob.state !== 'running'
    tracker.startedAt = typeof localJob.startedAt === 'string' && localJob.startedAt ? localJob.startedAt : new Date().toISOString()
    const job = tracker.job
    tracker.dispose = this.chatJobs.subscribe(job.id, {
      afterSequence: Number.isSafeInteger(job.lastEventSequence) ? job.lastEventSequence : 0,
      onEvent: (event) => {
        if (['completed', 'error', 'cancelled'].includes(event.type)) tracker.terminalEvent = event
        if (event.type === 'note' && typeof event.text === 'string') {
          tracker.notes = [...tracker.notes, {
            type: 'note',
            provider: event.provider,
            text: event.text,
            redacted: event.redacted === true,
            at: event.at,
          }].slice(-LIVE_TURN_NOTE_LIMIT)
          this.#reportProgress(tracker)
        }
        if (!tracker.pendingSequences.has(event.sequence)) {
          tracker.pendingSequences.add(event.sequence)
          tracker.pendingEvents.push(event)
        }
        void this.#flushEvents(tracker)
      },
      onEnd: () => {
        tracker.ended = true
        this.#reportConversation(tracker)
        void this.#flushEvents(tracker).finally(() => this.#retireTracker(tracker))
      },
    })
    if (!tracker.ended) this.#reportProgress(tracker)
  }

  /** Ends a tracker that never started a chat job (rejected, or stopped while queued). */
  #failTracker(tracker, error, { cancelled = false } = {}) {
    const sequence = (tracker.job.lastEventSequence ?? 0) + 1
    let event
    if (cancelled) {
      event = { type: 'cancelled', message: 'Stopped before it started.', at: new Date().toISOString(), sequence }
    } else {
      const failure = errorPayload(error)
      event = {
        type: 'error',
        error: failure.message,
        code: failure.code,
        status: failure.status,
        safeToRetry: failure.safeToRetry,
        at: new Date().toISOString(),
        sequence,
      }
    }
    const wasWaiting = Boolean(tracker.waiting)
    tracker.waiting = null
    tracker.ended = true
    tracker.neverStarted = cancelled
    tracker.terminalEvent = event
    tracker.pendingEvents.push(event)
    tracker.pendingSequences.add(event.sequence)
    if (wasWaiting) this.#reportQueue(tracker.conversation?.conversationId)
    this.#reportConversation(tracker)
  }

  /** Ends a queued turn whose prompt was delivered into the running turn. */
  #finishTransferred(tracker, ownerJobId) {
    const event = {
      type: 'completed',
      result: { transferredTo: ownerJobId, response: '' },
      at: new Date().toISOString(),
      sequence: (tracker.job.lastEventSequence ?? 0) + 1,
    }
    tracker.waiting = null
    tracker.ended = true
    tracker.neverStarted = true
    tracker.transferredTo = ownerJobId
    tracker.terminalEvent = event
    tracker.pendingEvents.push(event)
    tracker.pendingSequences.add(event.sequence)
    this.#reportQueue(tracker.conversation?.conversationId)
    this.#reportConversation(tracker)
  }

  /** The Host-side queue of one conversation, oldest first. */
  queuedTurns(conversationId) {
    return [...this.trackers.values()]
      .filter((tracker) => tracker.waiting && !tracker.ended && tracker.conversation?.conversationId === conversationId)
      .map((tracker) => ({
        jobId: tracker.job.id,
        ...(tracker.conversation.messageId ? { messageId: tracker.conversation.messageId } : {}),
        queuedAt: tracker.waiting.since,
      }))
  }

  #reportQueue(conversationId) {
    if (!conversationId || !this.onConversationQueueChanged) return
    this.queueReportedAt.set(conversationId, Date.now())
    try {
      void Promise.resolve(this.onConversationQueueChanged({
        conversationId,
        items: this.queuedTurns(conversationId),
        heartbeatAt: new Date().toISOString(),
      })).catch(() => {})
    } catch {
      // Queue mirroring is best effort.
    }
  }

  #heartbeatQueues() {
    const now = Date.now()
    const conversations = new Set([...this.trackers.values()]
      .filter((tracker) => tracker.waiting && !tracker.ended && tracker.conversation)
      .map((tracker) => tracker.conversation.conversationId))
    for (const conversationId of conversations) {
      const last = this.queueReportedAt.get(conversationId) ?? 0
      if (now - last >= this.liveHeartbeatMs) this.#reportQueue(conversationId)
    }
  }

  /**
   * Runs a phone control request: stop or steer the running turn of a
   * conversation (whichever device started it), or read its delivery status.
   * Control requests never reach a provider; they act on Host jobs and finish
   * at once with a small result.
   */
  async #runControl(job, identity) {
    const sequence = (job.lastEventSequence ?? 0) + 1
    try {
      const result = await this.#control(job, identity)
      return this.#syntheticTracker(job, {
        type: 'completed',
        result: { control: identity.request.control, ...result },
        at: new Date().toISOString(),
        sequence,
      })
    } catch (error) {
      const failure = errorPayload(error)
      return this.#syntheticTracker(job, {
        type: 'error',
        error: failure.message,
        code: failure.code,
        status: failure.status,
        safeToRetry: failure.safeToRetry,
        at: new Date().toISOString(),
        sequence,
      })
    }
  }

  #targetJob(request) {
    if (typeof request.targetJobId === 'string' && request.targetJobId) {
      const queued = this.trackers.get(request.targetJobId)
      if (queued?.waiting && !queued.ended) return { waiting: queued }
      try {
        const local = this.chatJobs.get(request.targetJobId)
        if (local.state === 'running') return { jobId: local.id }
      } catch (error) {
        if (!(error instanceof ChatJobError) || !['chat_job_not_found', 'invalid_chat_job'].includes(error.code)) throw error
      }
    }
    const running = this.chatJobs.runningForWorkspace?.(request.projectPath, request.workspaceKey) ?? null
    return running ? { jobId: running.id } : null
  }

  async #control(job, identity) {
    const request = identity.request
    const action = request.control
    if (action === 'cancel') {
      const target = this.#targetJob(request)
      if (!target) return { stopped: false, reason: 'not_running' }
      if (target.waiting) {
        this.#failTracker(target.waiting, null, { cancelled: true })
        return { stopped: true, jobId: target.waiting.job.id, queued: true }
      }
      const stopped = this.chatJobs.cancel(target.jobId)
      return { stopped: true, jobId: stopped.id }
    }
    if (action === 'steer') {
      if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
        throw new AccountSyncError('control_prompt_required', 'Write the instruction to send to the running agent.', 400)
      }
      const target = this.#targetJob(request)
      if (!target || target.waiting) {
        throw new AccountSyncError('control_not_running', 'No turn is running in this conversation.', 409)
      }
      const delivery = await this.chatJobs.steer(target.jobId, { idempotencyKey: job.id, prompt: request.prompt })
      return { steered: true, jobId: target.jobId, delivery: boundedDelivery(delivery) }
    }
    if (action === 'push_queued') {
      // The desktop's "Push now": deliver a queued prompt into the running
      // turn as a live instruction instead of waiting for that turn to end.
      const queued = typeof request.targetJobId === 'string' ? this.trackers.get(request.targetJobId) : null
      if (!queued?.waiting || queued.ended) {
        throw new AccountSyncError('control_not_queued', 'That message is no longer queued.', 409)
      }
      const owner = this.#targetJob({ projectPath: queued.request.projectPath, workspaceKey: queued.request.workspaceKey })
      if (!owner || owner.waiting) {
        throw new AccountSyncError('control_not_running', 'No turn is running in this conversation.', 409)
      }
      const delivery = await this.chatJobs.steer(owner.jobId, { idempotencyKey: queued.job.id, prompt: queued.request.prompt })
      this.#finishTransferred(queued, owner.jobId)
      return { pushed: true, jobId: owner.jobId, delivery: boundedDelivery(delivery) }
    }
    if (action === 'delivery_status') {
      if (typeof request.projectPath !== 'string' || !request.projectPath) {
        throw new AccountSyncError('invalid_project_path', 'A project path is required.', 400)
      }
      if (!this.deliveryStatus) return { delivery: null }
      const branch = typeof request.workspaceKey === 'string' && request.workspaceKey
        ? conversationBranchName(request.workspaceKey)
        : null
      return { delivery: summarizeDelivery(await this.deliveryStatus(request.projectPath, branch), branch) }
    }
    throw new AccountSyncError('control_unsupported', 'This Ensync Host does not support that control.', 400)
  }

  #reportProgress(tracker) {
    if (!tracker.conversation || !this.onConversationJobProgress || tracker.ended) return
    tracker.progressAt = Date.now()
    try {
      void Promise.resolve(this.onConversationJobProgress({
        jobId: tracker.job.id,
        conversationId: tracker.conversation.conversationId,
        messageId: tracker.conversation.messageId,
        provider: typeof tracker.request?.provider === 'string' ? tracker.request.provider : null,
        startedAt: tracker.startedAt,
        notes: tracker.notes,
        heartbeatAt: new Date(tracker.progressAt).toISOString(),
      })).catch(() => {})
    } catch {
      // Live progress is best effort and never blocks broker event delivery.
    }
  }

  #reportConversation(tracker) {
    if (!tracker.conversation || !this.onConversationJobFinished || tracker.conversationReported) return
    let terminalEvent = tracker.terminalEvent
    if (!terminalEvent) {
      // The subscription may start after the terminal event was retired from
      // the replay window; fall back to the durable job state.
      try {
        const local = this.chatJobs.get(tracker.job.id)
        if (local.state === 'completed') return
        terminalEvent = local.state === 'cancelled'
          ? { type: 'cancelled', message: 'The run was stopped.' }
          : { type: 'error', error: 'The Ensync Host run did not report a result.', code: local.state === 'failed' ? 'host_job_failed' : 'host_job_orphaned' }
      } catch {
        return
      }
    }
    tracker.conversationReported = true
    try {
      void Promise.resolve(this.onConversationJobFinished({
        jobId: tracker.job.id,
        conversationId: tracker.conversation.conversationId,
        messageId: tracker.conversation.messageId,
        request: tracker.request,
        terminalEvent,
        notes: Array.isArray(tracker.notes) ? tracker.notes : [],
        neverStarted: tracker.neverStarted === true,
        ...(tracker.transferredTo ? { transferredTo: tracker.transferredTo } : {}),
      })).catch(() => {})
    } catch {
      // Reply persistence never blocks broker event delivery.
    }
  }

  #reconcileMissingJob(job) {
    const tracker = this.#syntheticTracker(job, {
      type: 'error',
      error: 'Sync had already delivered this remote job, but the selected Host has no matching durable job record. Ensync did not replay it because project activity may have occurred.',
      code: 'broker_job_reconciliation_required',
      status: 409,
      safeToRetry: false,
      at: new Date().toISOString(),
      sequence: (job.lastEventSequence ?? 0) + 1,
    })
    return tracker
  }

  #rejectClaimedJob(job, error, identity = null) {
    const failure = errorPayload(error)
    const event = {
      type: 'error',
      error: failure.message,
      code: failure.code,
      status: failure.status,
      safeToRetry: failure.safeToRetry,
      at: new Date().toISOString(),
      sequence: (job.lastEventSequence ?? 0) + 1,
    }
    const tracker = this.#syntheticTracker(job, event)
    if (identity?.conversation) {
      tracker.conversation = identity.conversation
      tracker.request = identity.request
      tracker.terminalEvent = event
      this.#reportConversation(tracker)
    }
    return tracker
  }

  #syntheticTracker(job, event) {
    const tracker = {
      job,
      localJob: null,
      pendingEvents: [event],
      pendingSequences: new Set([event.sequence]),
      lastCommandSequence: 0,
      processedCommands: new Map(),
      ended: true,
      flushing: null,
      dispose: null,
    }
    this.trackers.set(job.id, tracker)
    return tracker
  }

  async #flushEvents(tracker) {
    if (tracker.flushing) return tracker.flushing
    tracker.flushing = (async () => {
      tracker.pendingEvents.sort((left, right) => left.sequence - right.sequence)
      while (tracker.pendingEvents.length) {
        const event = tracker.pendingEvents[0]
        try {
          const remote = await this.account.publishBrokerEvent(tracker.job, event)
          tracker.job.state = remote.state
          tracker.job.lastEventSequence = remote.lastEventSequence
          tracker.pendingEvents.shift()
          tracker.pendingSequences.delete(event.sequence)
          this.lastError = null
        } catch (error) {
          this.lastError = errorPayload(error)
          break
        }
      }
    })().finally(() => { tracker.flushing = null })
    return tracker.flushing
  }

  async #processCommands(tracker) {
    const commands = await this.account.pollBrokerCommands(tracker.job, tracker.lastCommandSequence)
    for (const command of commands) {
      if (command.ackedAt) {
        tracker.lastCommandSequence = Math.max(tracker.lastCommandSequence, command.sequence)
        continue
      }
      let acknowledgement = tracker.processedCommands.get(command.id)
      if (!acknowledgement) {
        const claim = await this.account.claimBrokerCommand(tracker.job, command)
        if (!claim.newlyClaimed) {
          acknowledgement = {
            accepted: false,
            reconciliationRequired: true,
            message: 'This command was already claimed without a retained acknowledgement. Ensync did not deliver it twice.',
          }
        } else {
          try {
            if (command.type === 'cancel' && tracker.waiting) {
              this.#failTracker(tracker, null, { cancelled: true })
              acknowledgement = { accepted: true, job: { id: tracker.job.id, state: 'cancelled' } }
            } else if (command.type === 'cancel') {
              acknowledgement = { accepted: true, job: this.chatJobs.cancel(tracker.job.id) }
            } else if (tracker.waiting) {
              acknowledgement = { accepted: false, error: { code: 'chat_job_queued', message: 'This turn is still queued; it can be steered once it starts.', status: 409, safeToRetry: true } }
            } else {
              // A phone steer carries no idempotency key of its own; the
              // broker command ID is already unique and stable across retries.
              const payload = { idempotencyKey: command.id, ...(command.payload ?? {}) }
              const delivery = await this.chatJobs.steer(tracker.job.id, payload)
              acknowledgement = { accepted: true, delivery, job: this.chatJobs.get(tracker.job.id) }
            }
          } catch (error) {
            acknowledgement = { accepted: false, error: errorPayload(error) }
          }
        }
        tracker.processedCommands.set(command.id, acknowledgement)
      }
      await this.account.acknowledgeBrokerCommand(tracker.job, command, acknowledgement)
      tracker.lastCommandSequence = Math.max(tracker.lastCommandSequence, command.sequence)
      tracker.processedCommands.delete(command.id)
    }
  }

  #retireTracker(tracker) {
    if (!tracker.ended || tracker.pendingEvents.length || tracker.flushing) return false
    tracker.dispose?.()
    this.trackers.delete(tracker.job.id)
    return true
  }
}

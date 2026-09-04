import { createHash } from 'node:crypto'
import { redactTerminalText } from './chat.mjs'

const DEFAULT_MAX_JOBS = 128
const DEFAULT_MAX_EVENTS = 1_000
const DEFAULT_MAX_EVENT_CHARACTERS = 2 * 1024 * 1024
const DEFAULT_FINISHED_TTL_MS = 24 * 60 * 60 * 1_000
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const STEER_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
const MAX_NAVIGATION_TURN_ID_CHARACTERS = 256

function eventSize(event) {
  try {
    return JSON.stringify(event).length
  } catch {
    return 0
  }
}

function assertJobId(value) {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    throw new ChatJobError('invalid_chat_job', 'A valid chat job ID is required.', 400)
  }
  return value
}

function requestKey(kind, request) {
  try {
    return JSON.stringify({ kind, request })
  } catch {
    throw new ChatJobError('invalid_chat_job', 'The chat job request must be serializable.', 400)
  }
}

function requestHash(key) {
  return createHash('sha256').update(key).digest('hex')
}

function steerDeliveryIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.idempotencyKey !== 'string'
    || !STEER_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new ChatJobError(
      'invalid_live_steer_idempotency_key',
      'A valid stable live-instruction ID is required.',
      400,
      true,
    )
  }
  return {
    key: input.idempotencyKey,
    request: JSON.stringify({
      prompt: typeof input.prompt === 'string' ? input.prompt.trim() : input.prompt,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
    }),
  }
}

function journalSafe(value) {
  if (typeof value === 'string') return redactTerminalText(value).text
  if (Array.isArray(value)) return value.map(journalSafe)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, journalSafe(item)]))
}

function defaultErrorPayload(error) {
  return {
    message: error instanceof Error ? error.message : 'Unexpected Ensync Host error.',
    code: typeof error?.code === 'string' ? error.code : 'unexpected_host_error',
    status: Number.isInteger(error?.status) ? error.status : 500,
    safeToRetry: error?.safeToRetry === true,
  }
}

function outputRecoveryNotice(result) {
  const recovery = result?.outputRecovery
  if (!recovery || recovery.applied !== true) return null
  const repairedLines = (Number.isSafeInteger(recovery.normalizedLineCount) ? recovery.normalizedLineCount : 0)
    + (Number.isSafeInteger(recovery.discardedLineCount) ? recovery.discardedLineCount : 0)
  if (repairedLines < 1) return null
  return `Ensync Host automatically repaired ${repairedLines.toLocaleString()} malformed provider output ${repairedLines === 1 ? 'line' : 'lines'} and verified the completed turn.`
}

function publicJob(job, canSteerLocal, pendingQuestionsLocal) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    firstSequence: job.events[0]?.sequence ?? job.sequence + 1,
    lastSequence: job.sequence,
    providerProcessStarted: job.providerProcessStarted,
    steerable: typeof canSteerLocal === 'function' && canSteerLocal(job.id) === true,
    // A renderer that reconnects mid-turn learns what the provider is blocked
    // on from the job itself, not only from the event it may have missed.
    pendingQuestions: job.state === 'running' && typeof pendingQuestionsLocal === 'function'
      ? pendingQuestionsLocal(job.id)
      : [],
  }
}

function publicOwnerFromStartInput(input, startedAt) {
  return {
    jobId: input.jobId,
    provider: typeof input.request?.provider === 'string' ? input.request.provider : null,
    targetKind: input.kind,
    startedAt,
    providerProcessStarted: false,
    steerable: false,
    nativeWorkspaceId: typeof input.navigation?.nativeWorkspaceId === 'string'
      ? input.navigation.nativeWorkspaceId
      : null,
  }
}

function boundedNavigationTurnId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_NAVIGATION_TURN_ID_CHARACTERS
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null
}

function boundedNavigationPredecessorFingerprint(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null
}

function updateLeaseOwner(lease, patch) {
  const update = lease?.updateOwner?.(patch)
  void update?.catch?.(() => {})
}

export class ChatJobError extends Error {
  constructor(code, message, status = 400, safeToRetry = false) {
    super(message)
    this.name = 'ChatJobError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

/**
 * Owns provider processes independently from renderer HTTP connections. A
 * stream subscriber may disappear and reconnect without cancelling the job;
 * only cancel() aborts the exact provider/OpenSSH process.
 */
export class ChatJobService {
  #jobs = new Map()
  #pendingStarts = new Map()
  #runLocal
  #runRemote
  #steerLocal
  #canSteerLocal
  #answerLocal
  #pendingQuestionsLocal
  #normalizeError
  #checkWorktreeClean
  #selectFallbackProvider
  #now
  #maxJobs
  #maxEvents
  #maxEventCharacters
  #finishedTtlMs
  #journal
  #persistTimer = null
  #admit
  #shuttingDown = false
  #restorationPromise = null

  constructor(options = {}) {
    if (typeof options.runLocal !== 'function' || typeof options.runRemote !== 'function') {
      throw new TypeError('Local and remote chat job runners are required.')
    }
    this.#runLocal = options.runLocal
    this.#runRemote = options.runRemote
    this.#steerLocal = options.steerLocal
    this.#canSteerLocal = options.canSteerLocal
    this.#answerLocal = options.answerLocal
    this.#pendingQuestionsLocal = options.pendingQuestionsLocal
    this.#normalizeError = options.normalizeError ?? defaultErrorPayload
    this.#checkWorktreeClean = options.checkWorktreeClean ?? null
    this.#selectFallbackProvider = options.selectFallbackProvider ?? null
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS
    this.#maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.#maxEventCharacters = options.maxEventCharacters ?? DEFAULT_MAX_EVENT_CHARACTERS
    this.#finishedTtlMs = options.finishedTtlMs ?? DEFAULT_FINISHED_TTL_MS
    this.#journal = options.journal ?? null
    this.#admit = options.admit ?? (async () => ({ disposition: 'acquired', lease: null }))
    this.#restorationPromise = this.#restoreJournal()
  }

  async ready() {
    if (this.#restorationPromise) {
      await this.#restorationPromise
      this.#restorationPromise = null
    }
  }

  async start(input) {
    await this.ready()
    if (!input || typeof input !== 'object') {
      throw new ChatJobError('invalid_chat_job', 'A chat job request is required.', 400)
    }
    const id = assertJobId(input.jobId)
    const kind = input.kind === 'ssh' ? 'ssh' : input.kind === 'local' ? 'local' : null
    if (!kind || !input.request || typeof input.request !== 'object' || Array.isArray(input.request)) {
      throw new ChatJobError('invalid_chat_job', 'The chat job kind and request are required.', 400)
    }
    const key = requestKey(kind, input.request)
    const hash = requestHash(key)
    if (this.#shuttingDown) {
      throw new ChatJobError(
        'chat_job_shutting_down',
        'Ensync Host is shutting down and cannot admit another chat job.',
        503,
        true,
      )
    }
    const existing = this.#jobs.get(id)
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new ChatJobError('chat_job_conflict', 'That chat job ID already belongs to another request.', 409)
      }
      return { disposition: 'reconnected', job: this.#publicJob(existing) }
    }

    const pending = this.#pendingStarts.get(id)
    if (pending) {
      if (pending.requestHash !== hash) {
        throw new ChatJobError('chat_job_conflict', 'That chat job ID already belongs to another request.', 409)
      }
      const admission = await pending.promise
      return admission.disposition === 'started'
        ? { disposition: 'reconnected', job: admission.job }
        : admission
    }

    this.#trimFinishedJobs(this.#pendingStarts.size)
    if (this.#jobs.size + this.#pendingStarts.size >= this.#maxJobs) {
      throw new ChatJobError('chat_job_capacity', 'Ensync Host has too many retained chat jobs.', 503)
    }
    // Queue admission only after publishing the reservation. Even a
    // synchronously re-entrant admission hook must observe this capacity use.
    const controller = new AbortController()
    const starting = Promise.resolve().then(() => this.#startNew(
      { ...input, jobId: id, kind },
      key,
      hash,
      controller.signal,
    ))
    this.#pendingStarts.set(id, { requestHash: hash, promise: starting, controller })
    try {
      return await starting
    } finally {
      this.#pendingStarts.delete(id)
    }
  }

  async #startNew(input, key, hash, signal) {
    const startedAt = this.#now()
    const admission = await this.#admit(
      input,
      publicOwnerFromStartInput(input, startedAt),
      { signal },
    )
    if (admission?.disposition === 'occupied') return this.#occupiedAdmission(admission)
    if (admission?.disposition !== 'acquired') {
      throw new ChatJobError('project_isolation_failed', 'Ensync Host could not admit this retained chat job.', 409)
    }
    if (this.#shuttingDown) {
      await admission.lease?.release()
      throw new ChatJobError(
        'chat_job_shutting_down',
        'Ensync Host began shutting down before this chat job could start.',
        503,
        true,
      )
    }

    const job = {
      id: input.jobId,
      kind: input.kind,
      request: input.request,
      requestKey: key,
      requestHash: hash,
      state: 'running',
      startedAt,
      finishedAt: null,
      providerProcessStarted: input.kind === 'ssh',
      sequence: 0,
      events: [],
      eventCharacters: 0,
      subscribers: new Set(),
      controller: new AbortController(),
      cancellationReason: null,
      completion: null,
      workspaceLease: admission.lease ?? null,
      steerDeliveries: new Map(),
      navigationTurnId: boundedNavigationTurnId(input.navigation?.turnId),
      navigationPredecessorFingerprint: boundedNavigationPredecessorFingerprint(
        input.navigation?.predecessorTranscriptFingerprint,
      ),
    }
    this.#jobs.set(input.jobId, job)
    // The idempotency record reaches durable storage before provider execution.
    // A crash can therefore become reconciliation-required, never a duplicate.
    try {
      this.#persist()
    } catch (error) {
      this.#jobs.delete(input.jobId)
      await job.workspaceLease?.release()
      throw new ChatJobError(
        'chat_job_journal_unavailable',
        error instanceof Error ? `Ensync Host could not durably register the run: ${error.message}` : 'Ensync Host could not durably register the run.',
        503,
        true,
      )
    }
    queueMicrotask(() => {
      job.completion = this.#execute(job)
    })
    return { disposition: 'started', job: this.#publicJob(job) }
  }

  #occupiedAdmission(admission) {
    const retained = this.#jobs.get(admission.owner?.jobId)
    return {
      disposition: 'occupied',
      owner: {
        ...(admission.owner ?? {}),
        turnId: retained?.state === 'running' ? retained.navigationTurnId : null,
        predecessorTranscriptFingerprint: retained?.state === 'running'
          ? retained.navigationPredecessorFingerprint
          : null,
      },
    }
  }

  get(jobId) {
    const job = this.#jobs.get(assertJobId(jobId))
    if (!job) throw new ChatJobError('chat_job_not_found', 'That chat job is no longer available.', 404)
    return this.#publicJob(job)
  }

  cancel(jobId) {
    const job = this.#jobs.get(assertJobId(jobId))
    if (!job) throw new ChatJobError('chat_job_not_found', 'That chat job is no longer available.', 404)
    if (job.state === 'running' && !job.controller.signal.aborted) {
      job.cancellationReason = 'user'
      job.controller.abort()
    }
    return this.#publicJob(job)
  }

  hasRunningJobs() {
    return this.#pendingStarts.size > 0
      || [...this.#jobs.values()].some((job) => job.state === 'running')
  }

  sweep() {
    const changed = this.#trimExpiredJobs()
    if (changed) this.#flushPersist()
    return changed
  }

  async shutdown() {
    this.#shuttingDown = true
    this.#flushPersist()
    const starting = [...this.#pendingStarts.values()]
    for (const item of starting) item.controller.abort()
    const pending = starting.map((item) => item.promise)
    await Promise.allSettled(pending)
    const running = [...this.#jobs.values()].filter((job) => job.state === 'running')
    for (const job of running) {
      job.cancellationReason = 'host_shutdown'
      job.controller.abort()
    }
    await Promise.allSettled(running.map((job) => job.completion).filter(Boolean))
    this.#flushPersist()
  }

  async steer(jobId, input) {
    const job = this.#jobs.get(assertJobId(jobId))
    if (!job) throw new ChatJobError('chat_job_not_found', 'That chat job is no longer available.', 404, true)
    const identity = steerDeliveryIdentity(input)
    const existing = job.steerDeliveries.get(identity.key)
    if (existing) {
      if (existing.request !== identity.request) {
        throw new ChatJobError(
          'live_steer_conflict',
          'That live-instruction ID already belongs to another message.',
          409,
          false,
        )
      }
      return existing.promise
    }
    const providerInput = {
      prompt: input.prompt,
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    }
    const promise = this.#deliverSteer(job, providerInput)
    job.steerDeliveries.set(identity.key, { request: identity.request, promise })
    return promise
  }

  async #deliverSteer(job, input) {
    if (job.state !== 'running') {
      throw new ChatJobError(
        'live_steer_unavailable',
        'The preceding turn already finished. This message was not delivered to it.',
        409,
        true,
      )
    }
    if (job.kind !== 'local' || job.request?.provider !== 'codex' || typeof this.#steerLocal !== 'function') {
      throw new ChatJobError(
        'live_steer_unavailable',
        'This provider or execution target cannot accept a live instruction. The message was not delivered.',
        409,
        true,
      )
    }
    if (typeof this.#canSteerLocal !== 'function' || this.#canSteerLocal(job.id) !== true) {
      throw new ChatJobError(
        'live_steer_unavailable',
        'Codex does not currently have an active turn that can accept this message. It was not delivered.',
        409,
        true,
      )
    }
    const delivery = await this.#steerLocal(job.id, input)
    updateLeaseOwner(job.workspaceLease, { steerable: true })
    return delivery
  }

  /**
   * Answers a question the live provider run is blocked on. SSH runs buffer
   * their provider output through a one-shot bridge with no channel back, so
   * they are refused here rather than silently dropped.
   */
  answer(jobId, input) {
    const job = this.#jobs.get(assertJobId(jobId))
    if (!job) throw new ChatJobError('chat_job_not_found', 'That chat job is no longer available.', 404)
    if (job.state !== 'running') {
      throw new ChatJobError(
        'question_not_found',
        'That run already finished, so the answer was not delivered to it.',
        409,
        false,
      )
    }
    if (job.kind !== 'local' || typeof this.#answerLocal !== 'function') {
      throw new ChatJobError(
        'question_unavailable',
        'This execution target cannot receive an answer. The message was not delivered.',
        409,
        false,
      )
    }
    return this.#answerLocal(job.id, input)
  }

  #publicJob(job) {
    const snapshot = publicJob(job, this.#canSteerLocal, this.#pendingQuestionsLocal)
    if (job.workspaceLease && job.state === 'running') {
      updateLeaseOwner(job.workspaceLease, {
        providerProcessStarted: snapshot.providerProcessStarted,
        steerable: snapshot.steerable,
      })
    }
    return snapshot
  }

  subscribe(jobId, options = {}) {
    const job = this.#jobs.get(assertJobId(jobId))
    if (!job) throw new ChatJobError('chat_job_not_found', 'That chat job is no longer available.', 404)
    const onEvent = options.onEvent
    const onEnd = options.onEnd
    if (typeof onEvent !== 'function' || typeof onEnd !== 'function') {
      throw new TypeError('Chat job event and completion callbacks are required.')
    }
    const afterSequence = Number.isSafeInteger(options.afterSequence) && options.afterSequence >= 0
      ? options.afterSequence
      : 0
    const firstSequence = job.events[0]?.sequence ?? job.sequence + 1
    if (afterSequence < firstSequence - 1) {
      this.#notifySubscriber({ onEvent, onEnd }, 'onEvent', {
        type: 'notice',
        message: 'Earlier live CLI events were omitted from the bounded Ensync Host recovery buffer.',
        at: job.startedAt,
        sequence: firstSequence - 1,
      })
    }
    for (const event of job.events) {
      if (event.sequence > afterSequence) this.#notifySubscriber({ onEvent, onEnd }, 'onEvent', event)
    }
    if (job.state !== 'running') {
      this.#notifySubscriber({ onEvent, onEnd }, 'onEnd')
      return () => false
    }

    const subscriber = { onEvent, onEnd }
    job.subscribers.add(subscriber)
    return () => job.subscribers.delete(subscriber)
  }

  async #execute(job) {
    try {
      let result
      let attempt = 0
      const MAX_AUTO_CONTINUATIONS = 3
      const attemptedProviders = [job.request?.provider].filter(Boolean)
      while (true) {
        try {
          if (job.kind === 'local') {
            result = await this.#runLocal(job.request, {
              liveTurnId: job.id,
              signal: job.controller.signal,
              preAcquiredWorkspaceLease: job.workspaceLease,
              onEvent: (event) => {
                if (event?.type === 'started') {
                  job.providerProcessStarted = true
                  updateLeaseOwner(job.workspaceLease, { providerProcessStarted: true })
                }
                if (event?.code === 'live_steer_ready') {
                  updateLeaseOwner(job.workspaceLease, { steerable: true })
                } else if (event?.code === 'live_steer_closed') {
                  updateLeaseOwner(job.workspaceLease, { steerable: false })
                }
                this.#record(job, event)
              },
            })
          } else {
            this.#record(job, {
              type: 'notice',
              message: 'SSH execution is continuing in Ensync Host. Provider output remains buffered by the verified SSH bridge.',
              at: this.#now(),
            })
            result = await this.#runRemote(job.request, {
              signal: job.controller.signal,
              onEvent: (event) => this.#record(job, event),
            })
          }
          break
        } catch (runError) {
          const runPayload = this.#normalizeError(runError)
          const isClean = job.kind === 'local'
            && this.#checkWorktreeClean
            && await this.#checkWorktreeClean(job.request)

          // Provider quota exhaustion: switch to the next provider if the
          // worktree is clean (no partial work would be lost).
          if (
            attempt < MAX_AUTO_CONTINUATIONS
            && runPayload.code === 'provider_quota'
            && runPayload.safeToRetry === true
            && isClean
            && this.#selectFallbackProvider
          ) {
            const nextProvider = await this.#selectFallbackProvider(attemptedProviders)
            if (nextProvider) {
              attempt++
              attemptedProviders.push(nextProvider)
              this.#record(job, {
                type: 'notice',
                message: `Provider ${job.request?.provider} exhausted its quota. The worktree is clean, so Ensync is continuing with ${nextProvider}.`,
                code: 'auto_continuation',
                at: this.#now(),
              })
              job.request = { ...job.request, provider: nextProvider, sessionId: null }
              continue
            }
          }

          // Context exhaustion (invalid_cli_output): continue with a fresh
          // session on the same or next provider if the worktree is clean.
          if (
            attempt < MAX_AUTO_CONTINUATIONS
            && runPayload.code === 'invalid_cli_output'
            && isClean
          ) {
            attempt++
            // Try to switch provider for better context capacity
            let nextProvider = job.request?.provider
            if (this.#selectFallbackProvider) {
              const fallback = await this.#selectFallbackProvider(attemptedProviders)
              if (fallback) {
                nextProvider = fallback
                attemptedProviders.push(fallback)
              }
            }
            this.#record(job, {
              type: 'notice',
              message: nextProvider !== job.request?.provider
                ? `Provider ${job.request?.provider} ran out of context. The worktree is clean, so Ensync is continuing with ${nextProvider}.`
                : 'Provider output exceeded the verified limit. The worktree is clean, so Ensync is continuing with a fresh session.',
              code: 'auto_continuation',
              at: this.#now(),
            })
            job.request = { ...job.request, provider: nextProvider, sessionId: null }
            continue
          }
          throw runError
        }
      }
      job.state = 'completed'
      job.finishedAt = this.#now()
      const recoveryNotice = outputRecoveryNotice(result)
      if (recoveryNotice) {
        this.#record(job, { type: 'notice', message: recoveryNotice, at: job.finishedAt })
      }
      this.#record(job, { type: 'completed', result, at: job.finishedAt })
    } catch (error) {
      const payload = this.#normalizeError(error)
      if (job.cancellationReason === 'host_shutdown') {
        job.state = 'failed'
        job.finishedAt = this.#now()
        this.#record(job, {
          type: 'error',
          error: 'Ensync Host ended before this provider run reported a terminal result. Project activity may be partial; reconcile before continuing.',
          code: 'host_job_orphaned',
          status: 409,
          safeToRetry: false,
          at: job.finishedAt,
        })
        return
      }
      const cancelled = payload.code === 'run_cancelled' || job.controller.signal.aborted
      job.state = cancelled ? 'cancelled' : 'failed'
      job.finishedAt = this.#now()
      this.#record(job, cancelled ? {
        type: 'cancelled',
        message: payload.message,
        code: 'run_cancelled',
        status: 499,
        safeToRetry: false,
        at: job.finishedAt,
      } : {
        type: 'error',
        error: payload.message,
        code: payload.code,
        status: payload.status,
        safeToRetry: payload.safeToRetry,
        at: job.finishedAt,
      })
    } finally {
      updateLeaseOwner(job.workspaceLease, { steerable: false })
      await job.workspaceLease?.release()
    }
  }

  #record(job, event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return
    const recorded = { ...event, sequence: ++job.sequence }
    job.events.push(recorded)
    job.eventCharacters += eventSize(recorded)
    while (job.events.length > 1 && (
      job.events.length > this.#maxEvents
      || job.eventCharacters > this.#maxEventCharacters
    )) {
      job.eventCharacters -= eventSize(job.events.shift())
    }
    for (const subscriber of [...job.subscribers]) {
      if (!this.#notifySubscriber(subscriber, 'onEvent', recorded)) job.subscribers.delete(subscriber)
    }
    if (['completed', 'error', 'cancelled'].includes(recorded.type)) {
      for (const subscriber of [...job.subscribers]) this.#notifySubscriber(subscriber, 'onEnd')
      job.subscribers.clear()
    }
    try {
      if (['started', 'completed', 'error', 'cancelled'].includes(recorded.type)) {
        this.#flushPersist()
      } else {
        this.#schedulePersist(job)
      }
    } catch (error) {
      // The initial running record was already durable before execution. If a
      // later checkpoint cannot be written, keep the live result authoritative;
      // a subsequent Host will reconcile the retained running record rather
      // than ever replaying the request.
      job.journalFailure = error instanceof Error ? error.message : 'Chat job journal write failed.'
    }
  }

  #notifySubscriber(subscriber, method, value) {
    try {
      subscriber[method](value)
      return true
    } catch {
      // A disconnected response stream never owns provider or retained-job truth.
      return false
    }
  }

  #trimFinishedJobs(pendingCount = 0) {
    this.#trimExpiredJobs()
    if (this.#jobs.size + pendingCount < this.#maxJobs) return
    for (const [id, job] of this.#jobs) {
      if (job.state === 'running') continue
      this.#jobs.delete(id)
      if (this.#jobs.size + pendingCount < this.#maxJobs) return
    }
  }

  #trimExpiredJobs() {
    const cutoff = Date.now() - this.#finishedTtlMs
    let changed = false
    for (const [id, job] of this.#jobs) {
      if (job.state === 'running') continue
      const finishedAt = Date.parse(job.finishedAt ?? '')
      if (Number.isFinite(finishedAt) && finishedAt > cutoff) continue
      this.#jobs.delete(id)
      changed = true
    }
    return changed
  }

  async #restoreJournal() {
    if (!this.#journal) return
    const restored = this.#journal.load()
    let journalNeedsRewrite = false
    for (const item of restored) {
      if (!item || typeof item !== 'object') continue
      try { assertJobId(item.id) } catch { continue }
      if (!['local', 'ssh'].includes(item.kind)
        || typeof item.requestHash !== 'string'
        || !['running', 'completed', 'failed', 'cancelled'].includes(item.state)) continue
      const events = Array.isArray(item.events)
        ? item.events.filter((event) => event && typeof event.type === 'string'
          && Number.isSafeInteger(event.sequence) && event.sequence > 0)
        : []
      const job = {
        id: item.id,
        kind: item.kind,
        request: item.request ?? null,
        requestKey: null,
        requestHash: item.requestHash,
        projectPath: item.projectPath ?? null,
        workspaceKey: item.workspaceKey ?? null,
        state: item.state,
        startedAt: item.startedAt,
        finishedAt: item.finishedAt ?? null,
        providerProcessStarted: item.providerProcessStarted === true,
        sequence: events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0),
        events,
        eventCharacters: events.reduce((total, event) => total + eventSize(event), 0),
        subscribers: new Set(),
        controller: new AbortController(),
        cancellationReason: null,
        completion: null,
        workspaceLease: null,
        steerDeliveries: new Map(),
        navigationTurnId: null,
        navigationPredecessorFingerprint: null,
      }
      this.#jobs.set(job.id, job)
      if (job.state !== 'running'
        && (events.length !== 1 || !['completed', 'error', 'cancelled'].includes(events[0]?.type))) {
        journalNeedsRewrite = true
      }
    }
    journalNeedsRewrite = this.#trimExpiredJobs() || journalNeedsRewrite
    let reconciled = false
    for (const job of this.#jobs.values()) {
      if (job.state !== 'running') continue
      job.state = 'failed'
      job.finishedAt = this.#now()
      const worktreeClean = this.#checkWorktreeClean && job.projectPath && job.workspaceKey
        ? await this.#checkWorktreeClean({ projectPath: job.projectPath, workspaceKey: job.workspaceKey })
        : false
      const recorded = journalSafe(worktreeClean ? {
        type: 'error',
        error: 'The detached Ensync Host ended before this provider run reported a terminal result. The worktree is clean, so this run can be continued safely.',
        code: 'host_job_orphaned_retry',
        status: 409,
        safeToRetry: true,
        at: job.finishedAt,
        sequence: ++job.sequence,
      } : {
        type: 'error',
        error: 'The detached Ensync Host ended before this provider run reported a terminal result. Project activity may be partial; reconcile before continuing.',
        code: 'host_job_orphaned',
        status: 409,
        safeToRetry: false,
        at: job.finishedAt,
        sequence: ++job.sequence,
      })
      job.events.push(recorded)
      job.eventCharacters += eventSize(recorded)
      reconciled = true

      // Auto-retry: if the worktree was clean and we have the original request,
      // re-run the job with a fresh session instead of leaving it stranded.
      if (worktreeClean && job.request) {
        const retryJob = job
        retryJob.state = 'running'
        retryJob.finishedAt = null
        retryJob.cancellationReason = null
        retryJob.controller = new AbortController()
        retryJob.completion = null
        retryJob.workspaceLease = null
        retryJob.steerDeliveries = new Map()
        retryJob.navigationTurnId = null
        retryJob.navigationPredecessorFingerprint = null
        // Clear the session ID to start a fresh provider session
        retryJob.request = { ...retryJob.request, sessionId: null }
        this.#record(retryJob, {
          type: 'notice',
          message: 'Ensync Host restarted after an unexpected exit. The worktree is clean, so this run is continuing with a fresh session.',
          code: 'auto_continuation',
          at: this.#now(),
        })
        void this.#execute(retryJob).catch((retryError) => {
          const retryPayload = this.#normalizeError(retryError)
          retryJob.state = 'failed'
          retryJob.finishedAt = this.#now()
          const retryRecorded = journalSafe({
            type: 'error',
            error: retryPayload.message,
            code: retryPayload.code,
            status: retryPayload.status,
            safeToRetry: retryPayload.safeToRetry,
            at: retryJob.finishedAt,
            sequence: ++retryJob.sequence,
          })
          retryJob.events.push(retryRecorded)
          retryJob.eventCharacters += eventSize(retryRecorded)
          this.#schedulePersist(retryJob)
        })
      }
    }
    if (reconciled || journalNeedsRewrite) this.#persist()
  }

  #persist() {
    if (!this.#journal) return
    const jobs = [...this.#jobs.values()].map((job) => ({
      id: job.id,
      kind: job.kind,
      requestHash: job.requestHash,
      // Persist the full request for running jobs so they can be auto-retried
      // after a host restart. Completed/failed jobs don't need it.
      request: job.state === 'running' ? job.request : null,
      projectPath: job.request?.projectPath ?? null,
      workspaceKey: job.request?.workspaceKey ?? null,
      state: job.state,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      providerProcessStarted: job.providerProcessStarted,
      sequence: job.sequence,
      // A finished job's terminal event contains the complete result or exact
      // failure needed for renderer recovery. Persisting its entire live
      // stream forever made every active checkpoint rewrite all prior output.
      events: (job.state === 'running'
        ? job.events
        : job.events.filter((event) => ['completed', 'error', 'cancelled'].includes(event.type)).slice(-1)
      ).map(journalSafe),
    }))
    this.#journal.save(jobs)
  }

  #schedulePersist(job) {
    if (!this.#journal || this.#persistTimer) return
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null
      try {
        this.#persist()
      } catch (error) {
        job.journalFailure = error instanceof Error ? error.message : 'Chat job journal write failed.'
      }
    }, 250)
    this.#persistTimer.unref?.()
  }

  #flushPersist() {
    if (!this.#journal) return
    if (this.#persistTimer) clearTimeout(this.#persistTimer)
    this.#persistTimer = null
    this.#persist()
  }
}

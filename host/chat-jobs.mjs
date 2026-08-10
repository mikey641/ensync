import { createHash } from 'node:crypto'
import { redactTerminalText } from './chat.mjs'

const DEFAULT_MAX_JOBS = 128
const DEFAULT_MAX_EVENTS = 1_000
const DEFAULT_MAX_EVENT_CHARACTERS = 2 * 1024 * 1024
const DEFAULT_FINISHED_TTL_MS = 24 * 60 * 60 * 1_000
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/

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
  #runLocal
  #runRemote
  #steerLocal
  #canSteerLocal
  #answerLocal
  #pendingQuestionsLocal
  #normalizeError
  #now
  #maxJobs
  #maxEvents
  #maxEventCharacters
  #finishedTtlMs
  #journal
  #persistTimer = null

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
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS
    this.#maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.#maxEventCharacters = options.maxEventCharacters ?? DEFAULT_MAX_EVENT_CHARACTERS
    this.#finishedTtlMs = options.finishedTtlMs ?? DEFAULT_FINISHED_TTL_MS
    this.#journal = options.journal ?? null
    this.#restoreJournal()
  }

  start(input) {
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
    const existing = this.#jobs.get(id)
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new ChatJobError('chat_job_conflict', 'That chat job ID already belongs to another request.', 409)
      }
      return this.#publicJob(existing)
    }

    this.#trimFinishedJobs()
    if (this.#jobs.size >= this.#maxJobs) {
      throw new ChatJobError('chat_job_capacity', 'Ensync Host has too many retained chat jobs.', 503)
    }

    const job = {
      id,
      kind,
      request: input.request,
      requestKey: key,
      requestHash: hash,
      state: 'running',
      startedAt: this.#now(),
      finishedAt: null,
      providerProcessStarted: kind === 'ssh',
      sequence: 0,
      events: [],
      eventCharacters: 0,
      subscribers: new Set(),
      controller: new AbortController(),
      completion: null,
    }
    this.#jobs.set(id, job)
    // The idempotency record reaches durable storage before provider execution.
    // A crash can therefore become reconciliation-required, never a duplicate.
    try {
      this.#persist()
    } catch (error) {
      this.#jobs.delete(id)
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
    return this.#publicJob(job)
  }

  get(jobId) {
    const job = this.#jobs.get(assertJobId(jobId))
    if (!job) throw new ChatJobError('chat_job_not_found', 'That chat job is no longer available.', 404)
    return this.#publicJob(job)
  }

  cancel(jobId) {
    const job = this.#jobs.get(assertJobId(jobId))
    if (!job) throw new ChatJobError('chat_job_not_found', 'That chat job is no longer available.', 404)
    if (job.state === 'running' && !job.controller.signal.aborted) job.controller.abort()
    return this.#publicJob(job)
  }

  hasRunningJobs() {
    return [...this.#jobs.values()].some((job) => job.state === 'running')
  }

  sweep() {
    const changed = this.#trimExpiredJobs()
    if (changed) this.#flushPersist()
    return changed
  }

  async shutdown() {
    this.#flushPersist()
    const running = [...this.#jobs.values()].filter((job) => job.state === 'running')
    for (const job of running) job.controller.abort()
    await Promise.allSettled(running.map((job) => job.completion).filter(Boolean))
    this.#flushPersist()
  }

  async steer(jobId, input) {
    const job = this.#jobs.get(assertJobId(jobId))
    if (!job) throw new ChatJobError('chat_job_not_found', 'That chat job is no longer available.', 404, true)
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
    return this.#steerLocal(job.id, input)
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
    return publicJob(job, this.#canSteerLocal, this.#pendingQuestionsLocal)
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
      onEvent({
        type: 'notice',
        message: 'Earlier live CLI events were omitted from the bounded Ensync Host recovery buffer.',
        at: job.startedAt,
        sequence: firstSequence - 1,
      })
    }
    for (const event of job.events) {
      if (event.sequence > afterSequence) onEvent(event)
    }
    if (job.state !== 'running') {
      onEnd()
      return () => false
    }

    const subscriber = { onEvent, onEnd }
    job.subscribers.add(subscriber)
    return () => job.subscribers.delete(subscriber)
  }

  async #execute(job) {
    try {
      let result
      if (job.kind === 'local') {
        result = await this.#runLocal(job.request, {
          liveTurnId: job.id,
          signal: job.controller.signal,
          onEvent: (event) => {
            if (event?.type === 'started') job.providerProcessStarted = true
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
      job.state = 'completed'
      job.finishedAt = this.#now()
      const recoveryNotice = outputRecoveryNotice(result)
      if (recoveryNotice) {
        this.#record(job, { type: 'notice', message: recoveryNotice, at: job.finishedAt })
      }
      this.#record(job, { type: 'completed', result, at: job.finishedAt })
    } catch (error) {
      const payload = this.#normalizeError(error)
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
    for (const subscriber of [...job.subscribers]) subscriber.onEvent(recorded)
    if (['completed', 'error', 'cancelled'].includes(recorded.type)) {
      for (const subscriber of [...job.subscribers]) subscriber.onEnd()
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

  #trimFinishedJobs() {
    this.#trimExpiredJobs()
    if (this.#jobs.size < this.#maxJobs) return
    for (const [id, job] of this.#jobs) {
      if (job.state === 'running') continue
      this.#jobs.delete(id)
      if (this.#jobs.size < this.#maxJobs) return
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

  #restoreJournal() {
    if (!this.#journal) return
    const restored = this.#journal.load()
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
        request: null,
        requestKey: null,
        requestHash: item.requestHash,
        state: item.state,
        startedAt: item.startedAt,
        finishedAt: item.finishedAt ?? null,
        providerProcessStarted: item.providerProcessStarted === true,
        sequence: events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0),
        events,
        eventCharacters: events.reduce((total, event) => total + eventSize(event), 0),
        subscribers: new Set(),
        controller: new AbortController(),
        completion: null,
      }
      this.#jobs.set(job.id, job)
    }
    this.#trimExpiredJobs()
    let reconciled = false
    for (const job of this.#jobs.values()) {
      if (job.state !== 'running') continue
      job.state = 'failed'
      job.finishedAt = this.#now()
      const recorded = journalSafe({
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
    }
    if (reconciled) this.#persist()
  }

  #persist() {
    if (!this.#journal) return
    const jobs = [...this.#jobs.values()].map((job) => ({
      id: job.id,
      kind: job.kind,
      requestHash: job.requestHash,
      state: job.state,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      providerProcessStarted: job.providerProcessStarted,
      sequence: job.sequence,
      events: job.events.map(journalSafe),
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

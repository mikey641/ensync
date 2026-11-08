// Live two-way sync for the phone: keeps the decrypted workspace document,
// long-polls for desktop changes, pushes phone edits with conflict re-merge,
// and drives brokered turns (submit, live events, stop, steer).

import { SyncError } from './broker-client.js'
import { applyPendingOps, normalizeWorkspace, replyAfter } from './workspace.js'

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'reconciliation_required'])
const WORKSPACE_KEY = 'ensync-phone-workspace-v1'
const OUTBOX_KEY = 'ensync-phone-outbox-v1'
const MAX_PUSH_ATTEMPTS = 6
const FALLBACK_POLL_MS = 4_000
const JOB_POLL_MS = 1_000
const HIDDEN_JOB_POLL_MS = 5_000
const COMPLETED_JOB_RETENTION_MS = 10 * 60 * 1000

export { TERMINAL_STATES }

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

function readJson(storage, key) {
  try {
    const raw = storage?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the in-memory state stays authoritative.
  }
}

export function isQuickTunnel(baseUrl) {
  try { return new URL(baseUrl).hostname.endsWith('.trycloudflare.com') } catch { return false }
}

export class PhoneSync {
  constructor(client, { storage = globalThis.localStorage, onChange = () => {}, isVisible = () => true } = {}) {
    this.client = client
    this.storage = storage
    this.onChange = onChange
    this.isVisible = isVisible
    const cached = readJson(storage, WORKSPACE_KEY)
    const sameAccount = cached?.username === client.username && cached?.baseUrl === client.baseUrl
    this.doc = sameAccount ? normalizeWorkspace(cached.doc) : normalizeWorkspace(null)
    this.revision = sameAccount && Number.isSafeInteger(cached.revision) ? cached.revision : 0
    this.loaded = false
    const outbox = readJson(storage, OUTBOX_KEY)
    const outboxMatches = outbox?.deviceId === client.deviceId
    this.ops = outboxMatches && Array.isArray(outbox.ops) ? outbox.ops : []
    this.jobs = outboxMatches && Array.isArray(outbox.jobs) ? outbox.jobs.map((job) => ({ ...job, events: [] })) : []
    this.status = { state: 'connecting', failures: 0, error: null }
    this.host = client.host ?? null
    this.waitSupported = true
    this.running = false
    this.abort = null
    this.flushing = null
    this.jobTimer = null
    this.viewCache = null
  }

  // ---- state -------------------------------------------------------------

  /** The document as the phone shows it: server state plus unsent phone edits. */
  view() {
    const key = `${this.revision}:${this.ops.length}:${this.ops.at(-1)?.message.id ?? ''}`
    if (this.viewCache?.key !== key || this.viewCache.doc !== this.doc) {
      this.viewCache = { key, doc: this.doc, view: applyPendingOps(this.doc, this.ops) }
    }
    return this.viewCache.view
  }

  chat(chatId) {
    return this.view().chats.find((chat) => chat.id === chatId) ?? null
  }

  pendingMessageIds() {
    return new Set(this.ops.map((op) => op.message.id))
  }

  jobsForChat(chatId) {
    return this.jobs.filter((job) => job.chatId === chatId)
  }

  #persistWorkspace() {
    writeJson(this.storage, WORKSPACE_KEY, {
      username: this.client.username,
      baseUrl: this.client.baseUrl,
      revision: this.revision,
      doc: this.doc,
    })
  }

  #persistOutbox() {
    writeJson(this.storage, OUTBOX_KEY, {
      deviceId: this.client.deviceId,
      ops: this.ops,
      jobs: this.jobs.map(({ events: _events, ...job }) => job),
    })
  }

  #emit() {
    try { this.onChange(this) } catch (error) { console.error(error) }
  }

  #setStatus(state, error = null) {
    const failures = state === 'offline' ? this.status.failures + 1 : 0
    const changed = this.status.state !== state || this.status.error?.message !== error?.message
    this.status = { state, failures, error }
    if (changed) this.#emit()
  }

  #adopt(result) {
    if (!result?.changed || result.revision < this.revision && this.loaded) return
    this.doc = normalizeWorkspace(result.state)
    this.revision = result.revision
    this.loaded = true
    this.#settleJobs()
    this.#persistWorkspace()
    this.#emit()
  }

  // ---- live loop ---------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    void this.#loop()
    void this.#refreshHost()
    void this.hydrateJobEvents()
  }

  stop() {
    this.running = false
    this.abort?.abort()
    clearTimeout(this.jobTimer)
  }

  /** Wake the loop immediately (e.g. the app came back to the foreground). */
  poke() {
    this.abort?.abort()
    this.#scheduleJobs(0)
    if (this.status.state === 'offline') void this.#refreshHost()
  }

  async #refreshHost() {
    try {
      const hosts = await this.client.hosts()
      const host = hosts.find((item) => item.id === this.client.host?.id) ?? hosts[0] ?? null
      if (host) {
        this.host = host
        this.client.host = { ...this.client.host, ...host }
        this.client.onChange?.(this.client)
        this.#emit()
      }
    } catch {
      // The workspace loop reports reachability; Host details are optional.
    }
  }

  async #loop() {
    let backoff = 1_000
    while (this.running) {
      this.abort = new AbortController()
      const { signal } = this.abort
      try {
        if (!this.loaded) {
          this.#adopt(await this.client.getWorkspace())
          void this.#process()
        } else if (this.waitSupported) {
          const result = await this.client.waitWorkspace(this.revision, { signal })
          if (result.changed) this.#adopt(result)
        } else {
          await sleep(FALLBACK_POLL_MS, signal)
          if (!this.running) break
          const result = await this.client.getWorkspace()
          if (result.revision !== this.revision) this.#adopt(result)
        }
        if (this.status.state !== 'live') {
          this.#setStatus('live')
          void this.#process()
          void this.#refreshHost()
        }
        backoff = 1_000
      } catch (error) {
        if (error?.name === 'AbortError') continue
        if (error instanceof SyncError && error.status === 404 && error.code === 'not_found' && this.waitSupported && this.loaded) {
          this.waitSupported = false
          continue
        }
        if (error?.code === 'link_revoked') {
          this.#setStatus('revoked', error)
          this.running = false
          break
        }
        this.#setStatus(error?.code === 'network_unreachable' ? 'offline' : 'error', error)
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, 15_000)
      }
    }
  }

  // ---- phone edits and turns --------------------------------------------

  /**
   * Sends a prompt from the phone. Appends the user message to the chat (creating
   * the chat when `newChat` is given), pushes the document, then submits the
   * brokered job. Returns the message id.
   */
  send({ chat, project, newProject = null, message, request }) {
    const hostId = this.client.host?.id
    // A new turn supersedes finished or failed turns shown for this chat.
    this.jobs = this.jobs.filter((job) => job.chatId !== chat.id || !(TERMINAL_STATES.has(job.state) || job.state === 'failed'))
    this.ops.push({ chatId: chat.id, chat: { ...chat, messages: [] }, project: newProject, message })
    this.jobs.push({
      jobId: `job_${crypto.randomUUID()}`,
      hostId,
      chatId: chat.id,
      messageId: message.id,
      projectId: project.id,
      request: { ...request, messageId: message.id, conversationId: chat.id },
      submitted: false,
      state: 'sending',
      lastSequence: 0,
      createdAt: new Date().toISOString(),
      events: [],
      error: null,
    })
    this.#persistOutbox()
    this.viewCache = null
    this.#emit()
    void this.#process()
    return message.id
  }

  async flush() {
    if (this.flushing) return this.flushing
    const run = (async () => {
      await null
      try {
        for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS && this.ops.length && this.loaded; attempt += 1) {
          const ops = [...this.ops]
          const next = applyPendingOps(this.doc, ops)
          const result = await this.client.putWorkspace(next, this.revision)
          if (result.status === 'saved') {
            this.doc = next
            this.revision = result.revision
            const sent = new Set(ops.map((op) => op.message.id))
            this.ops = this.ops.filter((op) => !sent.has(op.message.id))
          } else {
            this.doc = normalizeWorkspace(result.state)
            this.revision = result.revision
          }
          this.viewCache = null
          this.#persistWorkspace()
          this.#persistOutbox()
          this.#emit()
        }
      } finally {
        if (this.flushing === run) this.flushing = null
      }
    })()
    this.flushing = run
    return run
  }

  async #process() {
    try {
      await this.flush()
    } catch (error) {
      this.#noteError(error)
      return
    }
    const pending = this.pendingMessageIds()
    for (const job of this.jobs) {
      if (job.submitted || pending.has(job.messageId) || job.state === 'failed') continue
      if (!job.hostId) {
        job.state = 'failed'
        job.error = 'No computer is linked to run this turn. Scan the QR again.'
        continue
      }
      try {
        const remote = await this.client.submit({ hostId: job.hostId, jobId: job.jobId, request: job.request })
        job.submitted = true
        job.clientId = remote.clientId ?? this.client.deviceId
        job.state = remote.state ?? 'queued'
        job.error = null
      } catch (error) {
        if (error?.code === 'network_unreachable') { this.#noteError(error); break }
        job.state = 'failed'
        job.error = error?.message ?? 'The turn could not be sent to your computer.'
      }
      this.#persistOutbox()
      this.#emit()
    }
    this.#scheduleJobs(0)
  }

  #noteError(error) {
    if (error?.code === 'link_revoked') this.#setStatus('revoked', error)
    else if (error?.code === 'network_unreachable') this.#setStatus('offline', error)
    else {
      this.status = { ...this.status, error }
      this.#emit()
    }
  }

  /** Retries a failed turn (same job id when it was never accepted, so it stays idempotent). */
  retry(jobId) {
    const job = this.jobs.find((item) => item.jobId === jobId)
    if (!job) return
    if (job.submitted) {
      job.jobId = `job_${crypto.randomUUID()}`
      job.submitted = false
      job.lastSequence = 0
      job.events = []
    }
    job.state = 'sending'
    job.error = null
    this.#persistOutbox()
    this.#emit()
    void this.#process()
  }

  dismiss(jobId) {
    this.jobs = this.jobs.filter((job) => job.jobId !== jobId)
    this.#persistOutbox()
    this.#emit()
  }

  async command(jobId, type, payload = {}) {
    const job = this.jobs.find((item) => item.jobId === jobId)
    if (!job?.submitted) throw new Error('This turn has not reached your computer yet.')
    const command = await this.client.command({ id: job.jobId, hostId: job.hostId, clientId: job.clientId }, type, payload)
    if (type === 'steer' && payload.prompt) {
      job.events.push({ type: 'steer', message: payload.prompt, at: new Date().toISOString(), local: true })
    }
    if (type === 'cancel') job.stopping = true
    this.#emit()
    this.#scheduleJobs(150)
    return command
  }

  #scheduleJobs(delay) {
    clearTimeout(this.jobTimer)
    if (!this.running) return
    const active = this.jobs.some((job) => job.submitted && !TERMINAL_STATES.has(job.state))
    if (!active) return
    const wait = delay ?? (this.isVisible() ? JOB_POLL_MS : HIDDEN_JOB_POLL_MS)
    this.jobTimer = setTimeout(() => void this.#pollJobs(), wait)
  }

  async #pollJobs() {
    let changed = false
    for (const job of this.jobs) {
      if (!job.submitted || TERMINAL_STATES.has(job.state)) continue
      try {
        const remote = await this.client.job(job.jobId, job.lastSequence)
        if (remote.events.length) {
          job.events.push(...remote.events)
          job.lastSequence = Math.max(job.lastSequence, ...remote.events.map((event) => event.sequence))
          changed = true
        }
        if (remote.state !== job.state) {
          job.state = remote.state
          if (TERMINAL_STATES.has(job.state)) job.finishedAt = new Date().toISOString()
          changed = true
        }
        // Events can be trimmed by retention; reload the full list once after a reload.
        if (!job.events.length && job.lastSequence > 0) {
          const full = await this.client.job(job.jobId, 0)
          job.events = full.events
        }
      } catch (error) {
        if (error?.code === 'link_revoked' || error?.code === 'network_unreachable') { this.#noteError(error); break }
        if (error instanceof SyncError && error.status === 404) {
          job.state = 'failed'
          job.error = 'Your computer no longer has this turn.'
          changed = true
        }
      }
    }
    if (changed) {
      this.#settleJobs()
      this.#persistOutbox()
      this.#emit()
    }
    this.#scheduleJobs()
  }

  /** Reloads events for persisted jobs after an app restart (events are not stored). */
  async hydrateJobEvents() {
    for (const job of this.jobs) {
      if (!job.submitted || job.events.length) continue
      try {
        const remote = await this.client.job(job.jobId, 0)
        job.events = remote.events
        job.state = remote.state
        job.lastSequence = remote.events.reduce((max, event) => Math.max(max, event.sequence ?? 0), job.lastSequence)
      } catch {
        // Polling will retry.
      }
    }
    this.#settleJobs()
    this.#persistOutbox()
    this.#emit()
    this.#scheduleJobs(0)
  }

  /** Drops finished turns once their reply is durable in the document. */
  #settleJobs() {
    const now = Date.now()
    const before = this.jobs.length
    this.jobs = this.jobs.filter((job) => {
      if (job.state === 'failed' || job.state === 'reconciliation_required' || job.state === 'cancelled') return true
      if (!TERMINAL_STATES.has(job.state)) return true
      const chat = this.doc.chats.find((item) => item.id === job.chatId)
      if (replyAfter(chat, job.messageId)) return false
      const finished = Date.parse(job.finishedAt ?? '') || now
      return now - finished < COMPLETED_JOB_RETENTION_MS
    })
    if (this.jobs.length !== before) this.#persistOutbox()
  }
}

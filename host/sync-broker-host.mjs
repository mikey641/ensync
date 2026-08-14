import { AccountSyncError } from './account-sync.mjs'
import { ChatJobError } from './chat-jobs.mjs'

const DEFAULT_POLL_INTERVAL_MS = 1_000

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
        await this.#flushEvents(tracker)
        this.#retireTracker(tracker)
      }
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

    let localJob
    try {
      // start() is also the request-hash assertion for a retained job. When the
      // ID is new, the broker claim above was durably recorded first.
      const admission = await this.chatJobs.start({
        jobId: claimed.id,
        kind: claimed.kind,
        request: claimed.request,
      })
      if (admission.disposition === 'occupied') {
        return this.#rejectClaimedJob(claimed, new ChatJobError(
          'chat_job_occupied',
          'That project is already running another chat job.',
          409,
          false,
        ))
      }
      localJob = admission.job
    } catch (error) {
      return this.#rejectClaimedJob(claimed, error)
    }

    const tracker = {
      job: claimed,
      localJob,
      pendingEvents: [],
      pendingSequences: new Set(),
      lastCommandSequence: 0,
      processedCommands: new Map(),
      ended: localJob.state !== 'running',
      flushing: null,
      dispose: null,
    }
    this.trackers.set(job.id, tracker)
    tracker.dispose = this.chatJobs.subscribe(job.id, {
      afterSequence: Number.isSafeInteger(job.lastEventSequence) ? job.lastEventSequence : 0,
      onEvent: (event) => {
        if (!tracker.pendingSequences.has(event.sequence)) {
          tracker.pendingSequences.add(event.sequence)
          tracker.pendingEvents.push(event)
        }
        void this.#flushEvents(tracker)
      },
      onEnd: () => {
        tracker.ended = true
        void this.#flushEvents(tracker).finally(() => this.#retireTracker(tracker))
      },
    })
    return tracker
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

  #rejectClaimedJob(job, error) {
    const failure = errorPayload(error)
    return this.#syntheticTracker(job, {
      type: 'error',
      error: failure.message,
      code: failure.code,
      status: failure.status,
      safeToRetry: failure.safeToRetry,
      at: new Date().toISOString(),
      sequence: (job.lastEventSequence ?? 0) + 1,
    })
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
            if (command.type === 'cancel') {
              acknowledgement = { accepted: true, job: this.chatJobs.cancel(tracker.job.id) }
            } else {
              const delivery = await this.chatJobs.steer(tracker.job.id, command.payload)
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

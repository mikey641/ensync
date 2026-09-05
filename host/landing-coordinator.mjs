import { isAbsolute } from 'node:path'

import { runGit } from './git.mjs'

const MAX_ERROR_LENGTH = 4_096
const SAVED_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const DEFAULT_LANDING_RETRY_DELAYS = [1_000, 5_000, 30_000, 120_000, 600_000]

export async function anchorLandingSnapshot(input = {}, options = {}) {
  if (!isAbsolute(input.repositoryPath ?? '') || !SAVED_SHA_PATTERN.test(input.savedSha ?? '')) {
    throw new TypeError('A landing snapshot requires an absolute repository and exact commit SHA.')
  }
  const ref = `refs/ensync/landing-snapshots/${input.savedSha.toLowerCase()}`
  const gitRunner = options.gitRunner ?? runGit
  const invoke = (args) => gitRunner(['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: input.repositoryPath,
    gitExecutable: options.gitExecutable,
    timeoutMs: 30_000,
  })
  const [commit, existing] = await Promise.all([
    invoke(['cat-file', '-e', `${input.savedSha}^{commit}`]),
    invoke(['rev-parse', '--verify', ref]),
  ])
  if (commit.exitCode !== 0) throw new Error(`The saved commit ${input.savedSha} is unavailable.`)
  const existingSha = existing.exitCode === 0 ? existing.stdout.trim().toLowerCase() : null
  if (existingSha && existingSha !== input.savedSha.toLowerCase()) {
    throw new Error(`The immutable landing ref ${ref} was changed and will not be overwritten.`)
  }
  if (!existingSha) {
    const anchored = await invoke(['update-ref', ref, input.savedSha, '0'.repeat(input.savedSha.length)])
    if (anchored.exitCode !== 0) throw new Error(`Git could not anchor saved commit ${input.savedSha}.`)
  }
  // Anchors are intentionally retained after landing. Deleting a SHA-keyed
  // ref can race a concurrent enqueue of the same commit between its anchor
  // and journal append; retention makes that durability promise monotonic.
  return ref
}

function boundedError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown landing failure.')
  return message.slice(0, MAX_ERROR_LENGTH)
}

function normalizedResult(result, train) {
  const trainIds = new Set(train.map((item) => item.id))
  const landedIds = new Set(
    Array.isArray(result?.landedIds) ? result.landedIds.filter((id) => trainIds.has(id)) : [],
  )
  const retryIds = new Set(
    Array.isArray(result?.retryIds) ? result.retryIds.filter((id) => trainIds.has(id)) : [],
  )
  const errors = result?.errors && typeof result.errors === 'object' ? result.errors : {}
  const head = SAVED_SHA_PATTERN.test(result?.head ?? '') ? result.head.toLowerCase() : null
  const description = typeof result?.description === 'string' && result.description.trim()
    ? result.description.trim().slice(0, 240)
    : null
  return { errors, head, description, landedIds, retryIds }
}

/**
 * Event-driven, repository-scoped landing trains. Enqueue persists and returns;
 * integration always runs on a later microtask and never owns a provider job's
 * completion promise.
 */
export class LandingCoordinator {
  constructor(options = {}) {
    if (!options.journal || typeof options.journal.enqueue !== 'function') {
      throw new TypeError('LandingCoordinator requires a landing journal.')
    }
    if (typeof options.integrate !== 'function') {
      throw new TypeError('LandingCoordinator requires an integrate function.')
    }
    this.journal = options.journal
    this.anchorSnapshot = options.anchorSnapshot ?? options.journal.anchorSnapshot?.bind(options.journal)
    if (typeof this.anchorSnapshot !== 'function') {
      throw new TypeError('LandingCoordinator requires a durable snapshot anchor.')
    }
    this.integrate = options.integrate
    this.push = typeof options.push === 'function' ? options.push : null
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
    this.platform = options.platform ?? process.platform
    this.persistenceRetryDelays = options.persistenceRetryDelays ?? [100, 500, 2_000]
    this.landingRetryDelays = options.landingRetryDelays ?? DEFAULT_LANDING_RETRY_DELAYS
    this.repositories = new Map()
    this.idleWaiters = new Set()
    this.startPromise = null
    this.enqueueChain = Promise.resolve()
    this.stopping = false
    this.shutdownController = new AbortController()
    this.shutdownPromise = null
  }

  enqueue(input) {
    if (this.stopping) return Promise.reject(new Error('Automatic landing is shutting down.'))
    const enqueue = async () => {
      await this.anchorSnapshot(input)
      const item = await this.journal.enqueue(input)
      if (item.deliveryTarget === 'protected_branch') {
        const held = { ...item, state: 'held' }
        this.#emit('held', held)
        return held
      }
      const retained = await this.journal.load()
      for (const candidate of retained) {
        if (
          candidate.state === 'retry'
          && this.#repositoryKey(candidate) === this.#repositoryKey(item)
        ) {
          this.#markReady(candidate)
        }
      }
      const state = this.#stateFor(item)
      state.paused = false
      state.persistenceFailures = 0
      this.#markReady(item)
      return item
    }
    const result = this.enqueueChain.then(enqueue, enqueue)
    this.enqueueChain = result.catch(() => {})
    return result
  }

  start() {
    if (this.stopping) return Promise.resolve()
    this.startPromise ??= (async () => {
      const items = await this.journal.load()
      for (const item of items) {
      if (item.state === 'queued' || item.state === 'retry' || item.state === 'integrating') this.#markReady(item)
      }
    })()
    return this.startPromise
  }

  whenIdle() {
    if (this.#isIdle()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  hasActiveWork() {
    return !this.#isIdle()
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    this.stopping = true
    this.shutdownController.abort()
    this.shutdownPromise = (async () => {
      await this.enqueueChain.catch(() => {})
      for (const state of this.repositories.values()) {
        if (state.timer) clearTimeout(state.timer)
        if (state.retryTimer) clearTimeout(state.retryTimer)
        state.timer = null
        state.retryTimer = null
        state.retryDueAt = null
        state.scheduled = false
        state.paused = true
      }
      this.#notifyIdle()
      await this.whenIdle()
    })()
    return this.shutdownPromise
  }

  #repositoryKey(item) {
    const path = typeof item === 'string'
      ? item
      : item.commonGitDirectory ?? item.repositoryPath
    return this.platform === 'win32' ? path.toLowerCase() : path
  }

  #stateFor(item) {
    const key = this.#repositoryKey(item)
    let state = this.repositories.get(key)
    if (!state) {
      state = {
        key,
        repositoryPath: item.repositoryPath,
        ready: new Map(),
        running: false,
        scheduled: false,
        paused: false,
        persistenceFailures: 0,
        recoveryDelayMs: 0,
        timer: null,
        delayedRetries: new Map(),
        retryTimer: null,
        retryDueAt: null,
      }
      this.repositories.set(key, state)
    }
    return state
  }

  #markReady(item) {
    const state = this.#stateFor(item)
    if (state.delayedRetries.delete(item.id)) this.#scheduleRetryTimer(state)
    state.ready.set(item.id, { ...item })
    this.#emit('queued', item)
    this.#schedule(state)
  }

  #retryDelay(attempts) {
    if (this.landingRetryDelays.length === 0) return null
    const index = Math.min(
      Math.max(0, Number.isSafeInteger(attempts) ? attempts - 1 : 0),
      this.landingRetryDelays.length - 1,
    )
    const delay = this.landingRetryDelays[index]
    return Number.isFinite(delay) && delay >= 0 ? delay : null
  }

  #deferRetry(state, item) {
    const delay = this.#retryDelay(item.attempts)
    if (delay === null || this.stopping) return
    state.delayedRetries.set(item.id, {
      item: { ...item },
      dueAt: Date.now() + delay,
    })
    this.#scheduleRetryTimer(state)
  }

  #scheduleRetryTimer(state) {
    if (state.retryTimer) clearTimeout(state.retryTimer)
    state.retryTimer = null
    state.retryDueAt = null
    if (this.stopping || state.paused || state.delayedRetries.size === 0) return
    const dueAt = Math.min(...[...state.delayedRetries.values()].map((entry) => entry.dueAt))
    state.retryDueAt = dueAt
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      state.retryDueAt = null
      if (this.stopping || state.paused) {
        this.#notifyIdle()
        return
      }
      const now = Date.now()
      for (const [id, entry] of state.delayedRetries) {
        if (entry.dueAt > now) continue
        state.delayedRetries.delete(id)
        state.ready.set(id, { ...entry.item })
        this.#emit('queued', entry.item)
      }
      this.#scheduleRetryTimer(state)
      this.#schedule(state)
      this.#notifyIdle()
    }, Math.max(0, dueAt - Date.now()))
  }

  #schedule(state) {
    if (this.stopping || state.running || state.scheduled || state.paused) return
    state.scheduled = true
    const run = () => {
      state.timer = null
      state.scheduled = false
      if (this.stopping) {
        state.paused = true
        this.#notifyIdle()
        return
      }
      void this.#drain(state)
    }
    if (state.recoveryDelayMs > 0) {
      const delay = state.recoveryDelayMs
      state.recoveryDelayMs = 0
      state.timer = setTimeout(run, delay)
    } else {
      queueMicrotask(run)
    }
  }

  async #drain(state) {
    if (state.running) return
    state.running = true
    let recoveryItems = []
    let persistenceFailure = null
    try {
      while (!this.stopping && state.ready.size > 0) {
        const ordered = [...state.ready.values()]
          .sort((left, right) => left.completionSequence - right.completionSequence)
        const firstTarget = ordered[0]?.targetBranch ?? null
        const firstCheckout = ordered[0]?.repositoryPath ?? null
        const candidates = []
        for (const item of ordered) {
          if (
            (item.targetBranch ?? null) !== firstTarget
            || (item.repositoryPath ?? null) !== firstCheckout
          ) break
          candidates.push(item)
        }
        recoveryItems = candidates

        const train = []
        for (const original of candidates) {
          let item = original
          if (item.state === 'integrating') {
            const recovered = await this.journal.transition(
              item.id,
              'integrating',
              'retry',
              { error: 'A journal write interrupted automatic integration; the saved snapshot will retry.' },
            )
            if (!recovered) {
              state.ready.delete(item.id)
              continue
            }
            item = recovered
          }
          const integrating = await this.journal.transition(
            item.id,
            item.state,
            'integrating',
            { attempts: item.attempts + 1, error: null },
          )
          if (integrating) {
            state.ready.delete(item.id)
            train.push(integrating)
            this.#emit('integrating', integrating)
          } else {
            state.ready.delete(item.id)
          }
        }
        if (train.length === 0) continue

        let result
        try {
          result = normalizedResult(await this.integrate(train, {
            signal: this.shutdownController.signal,
          }), train)
        } catch (error) {
          const message = boundedError(error)
          result = {
            landedIds: new Set(),
            retryIds: new Set(train.map((item) => item.id)),
            errors: Object.fromEntries(train.map((item) => [item.id, message])),
          }
        }

        for (const item of train) {
          const landed = result.landedIds.has(item.id) && !result.retryIds.has(item.id)
          if (landed) {
            const transitioned = await this.journal.transition(item.id, 'integrating', 'landed', { error: null })
            if (transitioned) this.#emit('landed', transitioned)
            continue
          }
          const message = boundedError(
            result.errors[item.id]
              ?? (result.retryIds.has(item.id)
                ? 'Automatic integration will retry this saved branch.'
                : 'The integrator returned no terminal result for this saved branch.'),
          )
          const transitioned = await this.journal.transition(item.id, 'integrating', 'retry', { error: message })
          if (transitioned) {
            this.#emit('retry', transitioned, message)
            this.#deferRetry(state, transitioned)
          }
        }

        // Auto-push the target branch after a successful train landing. The
        // landing system already verified the merge with a no-force commit and
        // a reference-transaction guard; the push uses the same no-force policy.
        const landedAny = train.some((item) => result.landedIds.has(item.id) && !result.retryIds.has(item.id))
        if (landedAny && this.push) {
          const targetBranch = train[0]?.targetBranch ?? null
          const repositoryPath = train[0]?.repositoryPath ?? null
          if (targetBranch && repositoryPath) {
            try {
              const pushedHead = await this.push({
                repositoryPath,
                targetBranch,
                productionCommitSha: result.head,
                items: train.filter((item) => result.landedIds.has(item.id) && !result.retryIds.has(item.id)),
              })
              this.#emit('pushed', null, null, repositoryPath, {
                items: train.filter((item) => result.landedIds.has(item.id) && !result.retryIds.has(item.id)),
                productionCommitSha: SAVED_SHA_PATTERN.test(pushedHead ?? '')
                  ? pushedHead.toLowerCase()
                  : result.head,
                description: result.description,
                targetBranch,
              })
            } catch (error) {
              this.#emit('push-failed', null, boundedError(error), repositoryPath)
            }
          }
        }
        recoveryItems = []
        state.persistenceFailures = 0
      }
    } catch (error) {
      persistenceFailure = error
      await this.#recoverState(state, recoveryItems)
      this.#emit('coordinator-error', null, boundedError(error), state.repositoryPath)
    } finally {
      state.running = false
      if (persistenceFailure) {
        const delay = this.persistenceRetryDelays[state.persistenceFailures]
        state.persistenceFailures += 1
        if (Number.isFinite(delay) && delay >= 0) {
          state.recoveryDelayMs = delay
        } else {
          state.paused = true
        }
      }
      if (this.stopping) state.paused = true
      if (state.ready.size > 0) this.#schedule(state)
      this.#notifyIdle()
    }
  }

  async #recoverState(state, fallbackItems) {
    for (const item of fallbackItems) {
      if (['queued', 'retry', 'integrating'].includes(item.state)) state.ready.set(item.id, { ...item })
    }
    try {
      const durable = await this.journal.load()
      for (const item of durable) {
        if (
          ['queued', 'retry', 'integrating'].includes(item.state)
          && this.#repositoryKey(item) === state.key
        ) {
          state.ready.set(item.id, { ...item })
        }
      }
    } catch {
      // The in-flight copies above retain exact IDs and SHAs until storage recovers.
    }
  }

  #emit(type, item, error = null, repositoryPath = item?.repositoryPath ?? null, extra = {}) {
    try {
      this.onEvent({ type, item: item ? { ...item } : null, error, repositoryPath, ...extra })
    } catch {
      // Status listeners are advisory and cannot own the landing queue.
    }
  }

  #isIdle() {
    return [...this.repositories.values()].every((state) => (
      !state.running
      && !state.scheduled
      && (
        state.paused
        || (
          state.ready.size === 0
          && state.delayedRetries.size === 0
          && !state.retryTimer
        )
      )
    ))
  }

  #notifyIdle() {
    if (!this.#isIdle()) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

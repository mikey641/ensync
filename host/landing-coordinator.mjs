const MAX_ERROR_LENGTH = 4_096

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
  return { errors, landedIds, retryIds }
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
    this.integrate = options.integrate
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
    this.platform = options.platform ?? process.platform
    this.repositories = new Map()
    this.idleWaiters = new Set()
    this.startPromise = null
  }

  async enqueue(input) {
    const item = await this.journal.enqueue(input)
    this.#markReady(item)
    return item
  }

  start() {
    this.startPromise ??= (async () => {
      const items = await this.journal.load()
      for (const item of items) {
        if (item.state === 'queued' || item.state === 'retry') this.#markReady(item)
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

  #repositoryKey(path) {
    return this.platform === 'win32' ? path.toLowerCase() : path
  }

  #stateFor(item) {
    const key = this.#repositoryKey(item.repositoryPath)
    let state = this.repositories.get(key)
    if (!state) {
      state = {
        key,
        repositoryPath: item.repositoryPath,
        ready: new Map(),
        running: false,
        scheduled: false,
      }
      this.repositories.set(key, state)
    }
    return state
  }

  #markReady(item) {
    const state = this.#stateFor(item)
    state.ready.set(item.id, { ...item })
    this.#emit('queued', item)
    this.#schedule(state)
  }

  #schedule(state) {
    if (state.running || state.scheduled) return
    state.scheduled = true
    queueMicrotask(() => {
      state.scheduled = false
      void this.#drain(state).catch((error) => {
        state.running = false
        this.#emit('coordinator-error', null, boundedError(error), state.repositoryPath)
        this.#notifyIdle()
      })
    })
  }

  async #drain(state) {
    if (state.running) return
    state.running = true
    try {
      while (state.ready.size > 0) {
        const candidates = [...state.ready.values()]
          .sort((left, right) => left.completionSequence - right.completionSequence)
        for (const item of candidates) state.ready.delete(item.id)

        const train = []
        for (const item of candidates) {
          const integrating = await this.journal.transition(
            item.id,
            item.state,
            'integrating',
            { attempts: item.attempts + 1, error: null },
          )
          if (integrating) {
            train.push(integrating)
            this.#emit('integrating', integrating)
          }
        }
        if (train.length === 0) continue

        let result
        try {
          result = normalizedResult(await this.integrate(train), train)
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
          if (transitioned) this.#emit('retry', transitioned, message)
        }
      }
    } finally {
      state.running = false
      if (state.ready.size > 0) this.#schedule(state)
      this.#notifyIdle()
    }
  }

  #emit(type, item, error = null, repositoryPath = item?.repositoryPath ?? null) {
    try {
      this.onEvent({ type, item: item ? { ...item } : null, error, repositoryPath })
    } catch {
      // Status listeners are advisory and cannot own the landing queue.
    }
  }

  #isIdle() {
    return [...this.repositories.values()].every((state) => (
      !state.running && !state.scheduled && state.ready.size === 0
    ))
  }

  #notifyIdle() {
    if (!this.#isIdle()) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

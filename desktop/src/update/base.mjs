/**
 * Minimal ports of the VS Code base utilities the update service depends on:
 * `src/vs/base/common/{event,lifecycle,async,cancellation,errors}.ts`.
 *
 * Only the surface `AbstractUpdateService` and the platform services actually
 * use is reproduced here, so the ported update code can stay line-for-line
 * recognisable against upstream instead of being rewritten around Node
 * primitives.
 */

export function toDisposable(dispose) {
  return { dispose }
}

export class DisposableStore {
  #items = new Set()
  #disposed = false

  add(item) {
    if (!item) return item
    if (this.#disposed) {
      item.dispose?.()
      return item
    }
    this.#items.add(item)
    return item
  }

  clear() {
    const items = [...this.#items]
    this.#items.clear()
    for (const item of items) item.dispose?.()
  }

  dispose() {
    this.#disposed = true
    this.clear()
  }
}

export class Disposable {
  _store = new DisposableStore()

  _register(item) {
    return this._store.add(item)
  }

  dispose() {
    this._store.dispose()
  }
}

/** Holds at most one disposable; assigning a new value disposes the previous one. */
export class MutableDisposable {
  #value = undefined

  get value() {
    return this.#value
  }

  set value(next) {
    if (this.#value === next) return
    this.#value?.dispose?.()
    this.#value = next
  }

  clear() {
    this.value = undefined
  }

  dispose() {
    this.clear()
  }
}

export class Emitter {
  #listeners = new Set()

  /**
   * Mirrors VS Code's `Event<T>` call signature: `event(listener, thisArgs, disposables)`
   * returns a disposable that removes the listener.
   */
  get event() {
    return (listener, thisArgs, disposables) => {
      const bound = thisArgs ? listener.bind(thisArgs) : listener
      this.#listeners.add(bound)
      const disposable = toDisposable(() => this.#listeners.delete(bound))
      if (Array.isArray(disposables)) disposables.push(disposable)
      else disposables?.add?.(disposable)
      return disposable
    }
  }

  fire(value) {
    // A listener that throws must not stop delivery to the rest, exactly as in
    // VS Code where each listener is invoked inside its own error boundary.
    for (const listener of [...this.#listeners]) {
      try {
        listener(value)
      } catch {
        // ignore
      }
    }
  }

  dispose() {
    this.#listeners.clear()
  }
}

export class CancellationError extends Error {
  constructor() {
    super('Canceled')
    this.name = 'Canceled'
  }
}

export function isCancellationError(error) {
  return error instanceof CancellationError || error?.name === 'Canceled'
}

export const CancellationToken = Object.freeze({
  None: Object.freeze({
    isCancellationRequested: false,
    onCancellationRequested: () => toDisposable(() => {}),
  }),
})

export class CancellationTokenSource {
  #emitter = new Emitter()
  #cancelled = false

  get token() {
    const source = this
    return Object.freeze({
      get isCancellationRequested() { return source.#cancelled },
      onCancellationRequested: source.#emitter.event,
    })
  }

  cancel() {
    if (this.#cancelled) return
    this.#cancelled = true
    this.#emitter.fire()
  }

  dispose(cancel = false) {
    if (cancel) this.cancel()
    this.#emitter.dispose()
  }
}

/**
 * `timeout(ms)` from `base/common/async.ts`: a promise that resolves after the
 * delay and can be cancelled, rejecting with a cancellation error.
 */
export function timeout(millis, token) {
  let handle
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject
    handle = setTimeout(resolve, millis)
    handle.unref?.()
  })
  const cancel = () => {
    if (handle === undefined) return
    clearTimeout(handle)
    handle = undefined
    rejectPromise(new CancellationError())
  }
  promise.cancel = cancel
  token?.onCancellationRequested(cancel)
  return promise
}

/** `IntervalTimer` from `base/common/async.ts`. */
export class IntervalTimer {
  #token = undefined

  cancel() {
    if (this.#token === undefined) return
    clearInterval(this.#token)
    this.#token = undefined
  }

  cancelAndSet(runner, interval) {
    this.cancel()
    this.#token = setInterval(runner, interval)
    this.#token.unref?.()
  }

  dispose() {
    this.cancel()
  }
}

/**
 * `Throttler` from `base/common/async.ts`. While a task is running, further
 * `queue()` calls collapse into a single trailing run of the latest factory, so
 * overlapping reconfigurations settle on the newest value.
 */
export class Throttler {
  #activePromise = null
  #queuedPromise = null
  #queuedPromiseFactory = null

  queue(promiseFactory) {
    if (this.#activePromise) {
      this.#queuedPromiseFactory = promiseFactory

      if (!this.#queuedPromise) {
        const onComplete = () => {
          this.#queuedPromise = null
          const factory = this.#queuedPromiseFactory
          this.#queuedPromiseFactory = null
          return this.queue(factory)
        }
        this.#queuedPromise = new Promise((resolve) => {
          this.#activePromise.then(onComplete, onComplete).then(resolve)
        })
      }

      return new Promise((resolve, reject) => {
        this.#queuedPromise.then(resolve, reject)
      })
    }

    this.#activePromise = promiseFactory()

    return new Promise((resolve, reject) => {
      this.#activePromise.then((result) => {
        this.#activePromise = null
        resolve(result)
      }, (error) => {
        this.#activePromise = null
        reject(error)
      })
    })
  }

  dispose() {
    this.#activePromise = null
    this.#queuedPromise = null
    this.#queuedPromiseFactory = null
  }
}

const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/

export function shouldKeepDaemonAlive(activeLeaseCount, hasRunningJobs) {
  return Number.isInteger(activeLeaseCount) && activeLeaseCount > 0
    || hasRunningJobs === true
}

export class DaemonLeaseError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'DaemonLeaseError'
    this.code = code
    this.status = status
  }
}

function ownerId(value) {
  if (typeof value !== 'string' || !OWNER_ID_PATTERN.test(value)) {
    throw new DaemonLeaseError('invalid_daemon_owner', 'A valid native shell owner ID is required.')
  }
  return value
}

/**
 * Short, renewable native-shell leases let the detached Host distinguish an
 * ordinary renderer disconnect from an abandoned daemon. They are process
 * memory only: the bearer token in the user-only rendezvous file remains the
 * durable authentication boundary.
 */
export class DaemonLeaseService {
  #leases = new Map()
  #now
  #leaseMs

  constructor(options = {}) {
    this.#now = options.now ?? Date.now
    this.#leaseMs = options.leaseMs ?? 45_000
  }

  claim(value) {
    const id = ownerId(value)
    const expiresAtMs = this.#now() + this.#leaseMs
    this.#leases.set(id, expiresAtMs)
    return { ownerId: id, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  heartbeat(value) {
    const id = ownerId(value)
    this.#sweep()
    if (!this.#leases.has(id)) {
      throw new DaemonLeaseError('daemon_owner_expired', 'The native shell lease expired.', 409)
    }
    return this.claim(id)
  }

  release(value) {
    const id = ownerId(value)
    return { ownerId: id, released: this.#leases.delete(id) }
  }

  has(value) {
    let id
    try {
      id = ownerId(value)
    } catch {
      return false
    }
    this.#sweep()
    return this.#leases.has(id)
  }

  activeCount() {
    this.#sweep()
    return this.#leases.size
  }

  #sweep() {
    const now = this.#now()
    for (const [id, expiresAt] of this.#leases) {
      if (expiresAt <= now) this.#leases.delete(id)
    }
  }
}

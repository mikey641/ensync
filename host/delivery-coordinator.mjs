const DEFAULT_POLL_MS = 10_000
const DEFAULT_RETRY_DELAYS = [1_000, 5_000, 30_000, 120_000, 600_000]
const MAX_TURN_ID_CHARACTERS = 256
const TURN_IDENTITY_PROOFS = new Set(['captured', 'commit_trailer', 'legacy_job'])

function validTurnId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_TURN_ID_CHARACTERS
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

export function deliveryTurnIdentityFromCommitMessage(message, expected = {}) {
  if (typeof message !== 'string') return null
  const provider = message.match(/^Provider:\s*([a-z0-9._-]+)\s*$/im)?.[1]?.toLowerCase() ?? null
  const branch = message.match(/^Workspace-Branch:\s*([^\r\n]+)\s*$/im)?.[1]?.trim() ?? null
  if (expected.provider && provider !== String(expected.provider).toLowerCase()) return null
  if (expected.branch && branch !== expected.branch) return null

  const explicit = message.match(/^Turn-ID:\s*([^\r\n]+)\s*$/im)?.[1]?.trim()
  if (validTurnId(explicit)) return { turnId: explicit, proof: 'commit_trailer' }

  // Older Ensync snapshots encoded the turn only inside
  // Job: job-<turn-id>-<provider>-<attempt>. Both lines were Host-authored.
  const jobId = message.match(/^Job:\s*(job-[A-Za-z0-9_-]{15,127})\s*$/im)?.[1]
  if (!provider || !jobId) return null
  const providerSuffix = `-${provider}-`
  const providerIndex = jobId.lastIndexOf(providerSuffix)
  if (providerIndex <= 4 || !/^\d+$/.test(jobId.slice(providerIndex + providerSuffix.length))) return null
  const recovered = jobId.slice(4, providerIndex)
  return validTurnId(recovered) ? { turnId: recovered, proof: 'legacy_job' } : null
}

export function deliveryTurnIdFromCommitMessage(message) {
  return deliveryTurnIdentityFromCommitMessage(message)?.turnId ?? null
}

function timestampAfter(delay) {
  return new Date(Date.now() + delay).toISOString()
}

function publicRecord(record) {
  if (!record) return null
  const { failureLog, ...safe } = record
  return { ...safe, failureLogAvailable: Boolean(failureLog) }
}

export class DeliveryCoordinator {
  constructor(options = {}) {
    if (!options.journal) throw new TypeError('DeliveryCoordinator requires a delivery journal.')
    this.journal = options.journal
    this.adapters = Array.isArray(options.adapters) ? options.adapters : []
    this.findActiveChat = options.findActiveChat ?? (() => null)
    this.startRepair = options.startRepair ?? null
    this.isAncestor = options.isAncestor ?? (async () => false)
    this.resolvePushedHead = options.resolvePushedHead ?? null
    this.describeCommit = options.describeCommit ?? null
    this.resolveTurnId = options.resolveTurnId ?? null
    this.redact = options.redact ?? ((value) => value)
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS
    this.timers = new Map()
    this.running = new Set()
    this.stopping = false
  }

  async start() {
    let records = await this.journal.list()
    if (this.resolvePushedHead) {
      const projects = new Map()
      for (const record of records) {
        projects.set(`${record.repositoryPath}\0${record.targetBranch}`, record)
      }
      for (const record of projects.values()) await this.#recoverPushedHead(record)
      records = await this.journal.list()
    }
    for (const record of records) {
      if (record.deliveryTarget !== 'protected_branch' && record.state !== 'production') this.#schedule(record.id, 0)
    }
  }

  handleLandingEvent(event) {
    if (!event || this.stopping) return
    void this.#handleLandingEvent(event).catch(() => {})
  }

  async status(projectPath, sourceBranch = null) {
    let records = (await this.journal.list())
      .filter((record) => record.projectPath === projectPath || record.repositoryPath === projectPath)
    if (this.resolvePushedHead && records.length > 0 && !records.some((record) => record.state === 'production')) {
      await this.#recoverPushedHead(records[0])
      records = (await this.journal.list())
        .filter((record) => record.projectPath === projectPath || record.repositoryPath === projectPath)
    }
    if (typeof sourceBranch === 'string' && sourceBranch) {
      records = records.filter((record) => record.sourceBranches.includes(sourceBranch))
    }
    if (this.resolveTurnId) {
      records = await Promise.all(records.map(async (record) => {
        if (record.turnIds.length > 0 && TURN_IDENTITY_PROOFS.has(record.turnIdentityProof)) return record
        try {
          const identity = await this.resolveTurnId(record)
          if (!validTurnId(identity?.turnId) || !TURN_IDENTITY_PROOFS.has(identity?.proof)) return record
          if (record.turnIds.length > 0 && !record.turnIds.includes(identity.turnId)) return record
          return await this.journal.update(record.id, {
            turnIds: [identity.turnId],
            turnIdentityProof: identity.proof,
            productionAncestryVerified: false,
          }) ?? record
        } catch {
          return record
        }
      }))
    }
    records = await Promise.all(records.map(async (record) => {
      if (record.state !== 'production'
        || !record.productionCommitSha
        || !TURN_IDENTITY_PROOFS.has(record.turnIdentityProof)
        || record.turnIds.length < 1
        || record.productionAncestryVerified === true) return record
      try {
        const productionSha = record.replacementCommitSha ?? record.productionCommitSha
        if (!await this.isAncestor(record.repositoryPath, record.savedSha, productionSha)) return record
        return await this.journal.update(record.id, { productionAncestryVerified: true }) ?? record
      } catch {
        return record
      }
    }))
    if (this.describeCommit) {
      records = await Promise.all(records.map(async (record) => {
        if (record.description) return record
        const commitSha = record.productionCommitSha ?? record.savedSha
        try {
          const description = await this.describeCommit(record.repositoryPath, commitSha)
          if (!description) return record
          return await this.journal.update(record.id, { description }) ?? record
        } catch {
          return record
        }
      }))
    }
    records = records
      .sort((left, right) => Number(Boolean(left.replacementCommitSha)) - Number(Boolean(right.replacementCommitSha))
        || Date.parse(right.createdAt ?? right.updatedAt) - Date.parse(left.createdAt ?? left.updatedAt))
    const production = records
      .filter((record) => record.state === 'production')
      .sort((left, right) => Date.parse(right.productionAt ?? right.updatedAt) - Date.parse(left.productionAt ?? left.updatedAt))[0] ?? null
    const pending = records.find((record) => record.state !== 'production' && !record.replacementCommitSha) ?? null
    return {
      current: publicRecord(pending ?? production ?? records[0] ?? null),
      production: publicRecord(production),
      pending: publicRecord(pending),
      records: records.slice(0, 10).map(publicRecord),
    }
  }

  hasActiveWork() {
    return this.running.size > 0 || this.timers.size > 0
  }

  async shutdown() {
    this.stopping = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.allSettled([...this.running])
  }

  async #handleLandingEvent(event) {
    if (['held', 'queued', 'integrating', 'landed', 'retry'].includes(event.type) && event.item) {
      const state = ['held', 'queued'].includes(event.type) ? 'saved' : 'landing'
      await this.journal.upsertLanding(event.item, state)
      return
    }
    if (event.type !== 'pushed' || !Array.isArray(event.items) || !event.productionCommitSha) return
    for (const item of event.items) {
      const record = await this.journal.upsertLanding(item, 'pushed')
      await this.journal.update(record.id, {
        state: 'pushed',
        productionCommitSha: event.productionCommitSha,
        productionAncestryVerified: false,
        description: event.description ?? record.description,
        repairState: 'idle',
        nextActionAt: null,
      })
      this.#schedule(record.id, 0)
    }
    const records = await this.journal.list()
    for (const older of records) {
      if (older.productionCommitSha === event.productionCommitSha
        || older.repositoryPath !== event.repositoryPath
        || !['failed', 'repairing'].includes(older.state)) continue
      if (await this.isAncestor(older.repositoryPath, older.productionCommitSha, event.productionCommitSha)) {
        await this.journal.update(older.id, {
          state: 'repairing',
          repairState: 'waiting',
          replacementCommitSha: event.productionCommitSha,
          productionAncestryVerified: false,
          nextActionAt: null,
        })
      }
    }
  }

  async #recoverPushedHead(record) {
    let productionCommitSha
    try {
      productionCommitSha = await this.resolvePushedHead(record.repositoryPath, record.targetBranch)
    } catch {
      return null
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(productionCommitSha ?? '')) return null
    const normalizedSha = productionCommitSha.toLowerCase()
    const existing = (await this.journal.list()).find((candidate) => (
      candidate.repositoryPath === record.repositoryPath
      && candidate.targetBranch === record.targetBranch
      && candidate.productionCommitSha === normalizedSha
    ))
    if (existing) {
      if (existing.state !== 'production') this.#schedule(existing.id, 0)
      return existing
    }
    const recovered = await this.journal.upsertLanding({
      id: `recovered-${normalizedSha}`,
      repositoryPath: record.repositoryPath,
      projectPath: record.projectPath,
      targetBranch: record.targetBranch,
      savedSha: normalizedSha,
      branch: `production/${record.targetBranch}`,
      provider: null,
    }, 'pushed')
    const updated = await this.journal.update(recovered.id, {
      state: 'pushed',
      productionCommitSha: normalizedSha,
      productionAncestryVerified: false,
      repairState: 'idle',
      nextActionAt: null,
    })
    this.#schedule(updated.id, 0)
    return updated
  }

  #schedule(id, delay = this.pollMs) {
    if (this.stopping) return
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      const running = this.#poll(id)
      this.running.add(running)
      void running.finally(() => this.running.delete(running))
    }, Math.max(0, delay))
    timer.unref?.()
    this.timers.set(id, timer)
  }

  async #poll(id) {
    const record = (await this.journal.list()).find((candidate) => candidate.id === id)
    if (!record || record.deliveryTarget === 'protected_branch' || record.state === 'production' || this.stopping) return
    if (!record.productionCommitSha) {
      this.#schedule(id)
      return
    }
    const adapter = this.adapters[0]
    if (!adapter) {
      await this.journal.update(id, { state: 'unavailable', repairState: 'unavailable', failureMessage: 'No production deployment adapter is available.' })
      this.#schedule(id, 60_000)
      return
    }
    const observed = await adapter.inspect(record)
    if (!observed.available) {
      await this.journal.update(id, {
        state: 'unavailable',
        deploymentProvider: observed.provider,
        repairState: 'unavailable',
        failureMessage: observed.reason,
      })
      this.#schedule(id, 60_000)
      return
    }
    const deployment = {
      deploymentProvider: observed.provider,
      deploymentId: observed.deploymentId ?? null,
      deploymentUrl: observed.deploymentUrl ?? null,
      deploymentDashboardUrl: observed.deploymentDashboardUrl ?? null,
    }
    if (observed.state === 'missing' || observed.state === 'building') {
      await this.journal.update(id, {
        ...deployment,
        state: observed.state === 'building' ? 'building' : 'pushed',
        failureCode: null,
        failureMessage: null,
        failureLog: null,
      })
      this.#schedule(id)
      return
    }
    if (observed.state === 'ready') {
      const productionAt = new Date().toISOString()
      await this.journal.update(id, {
        ...deployment,
        state: 'production',
        repairState: 'idle',
        failureCode: null,
        failureMessage: null,
        failureLog: null,
        productionAt,
        nextActionAt: null,
      })
      for (const candidate of await this.journal.list()) {
        if (candidate.replacementCommitSha === record.productionCommitSha && candidate.state !== 'production') {
          await this.journal.update(candidate.id, { state: 'production', repairState: 'idle', productionAt, nextActionAt: null })
        }
      }
      return
    }
    const redactedLog = this.redact(observed.failureLog ?? '')
    const failed = await this.journal.update(id, {
      ...deployment,
      state: 'failed',
      failureCode: observed.failureCode ?? null,
      failureMessage: observed.failureMessage ?? 'The production deployment failed.',
      failureLog: redactedLog || null,
    })
    await this.#repair(failed)
  }

  async #repair(record) {
    const active = this.findActiveChat(record.projectPath)
    if (active) {
      await this.journal.update(record.id, {
        state: 'repairing',
        repairState: 'manual',
        repairJobId: active.id,
        repairProvider: active.provider,
        nextActionAt: timestampAfter(this.pollMs),
      })
      this.#schedule(record.id, this.pollMs)
      return
    }
    if (!this.startRepair) {
      await this.journal.update(record.id, { repairState: 'unavailable', lastRepairError: 'No automatic repair runner is available.' })
      this.#schedule(record.id, 60_000)
      return
    }
    const attempts = record.repairAttempts + 1
    try {
      const repair = await this.startRepair({ ...record, repairAttempts: attempts })
      const running = await this.journal.update(record.id, {
        state: 'repairing',
        repairState: 'running',
        repairAttempts: attempts,
        repairJobId: repair.jobId,
        repairProvider: repair.provider,
        attemptedProviders: [...record.attemptedProviders, repair.provider],
        nextActionAt: null,
        lastRepairError: null,
      })
      void Promise.resolve(repair.completion).then(async (result) => {
        if (this.stopping) return
        if (result?.state === 'completed') {
          await this.journal.update(running.id, {
            state: 'repairing', repairState: 'waiting', nextActionAt: timestampAfter(this.retryDelays.at(-1) ?? 600_000),
          })
          this.#schedule(running.id, this.retryDelays.at(-1) ?? 600_000)
        } else {
          await this.#repairFailed(running, result?.error ?? 'The automatic repair run did not complete.')
        }
      }).catch((error) => this.#repairFailed(running, error instanceof Error ? error.message : String(error)))
    } catch (error) {
      await this.#repairFailed({ ...record, repairAttempts: attempts }, error instanceof Error ? error.message : String(error))
    }
  }

  async #repairFailed(record, error) {
    if (this.stopping) return
    const index = Math.min(Math.max(0, record.repairAttempts - 1), this.retryDelays.length - 1)
    const delay = this.retryDelays[index] ?? 600_000
    await this.journal.update(record.id, {
      state: 'failed',
      repairState: 'idle',
      repairAttempts: record.repairAttempts,
      lastRepairError: String(error).slice(0, 4_096),
      nextActionAt: timestampAfter(delay),
    })
    this.#schedule(record.id, delay)
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

const JOURNAL_VERSION = 1
const MAX_RECORDS = 200
const MAX_TEXT = 16_384
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const STATES = new Set([
  'saved',
  'landing',
  'pushed',
  'building',
  'failed',
  'repairing',
  'production',
  'unavailable',
])
const LANDING_STATES = new Set(['held', 'queued', 'integrating', 'retry', 'landed'])
const DELIVERY_TARGETS = new Set(['production', 'protected_branch'])
const TURN_IDENTITY_PROOFS = new Set(['captured', 'commit_trailer', 'legacy_job'])

function checksum(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function text(value, maximum = MAX_TEXT) {
  return typeof value === 'string' && value.trim() ? value.slice(0, maximum) : null
}

function date(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function stringList(value, maximum = 64) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.slice(0, 512)))]
    .slice(0, maximum)
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = text(value.id, 160)
  const repositoryPath = text(value.repositoryPath, 8_192)
  const projectPath = text(value.projectPath, 8_192)
  const targetBranch = text(value.targetBranch, 512)
  const savedSha = text(value.savedSha, 64)?.toLowerCase()
  const productionCommitSha = text(value.productionCommitSha, 64)?.toLowerCase() ?? null
  const replacementCommitSha = text(value.replacementCommitSha, 64)?.toLowerCase() ?? null
  const createdAt = date(value.createdAt)
  const updatedAt = date(value.updatedAt)
  if (
    !id
    || !repositoryPath
    || !projectPath
    || !isAbsolute(repositoryPath)
    || !isAbsolute(projectPath)
    || !targetBranch
    || !SHA_PATTERN.test(savedSha ?? '')
    || (productionCommitSha && !SHA_PATTERN.test(productionCommitSha))
    || (replacementCommitSha && !SHA_PATTERN.test(replacementCommitSha))
    || !STATES.has(value.state)
    || !createdAt
    || !updatedAt
  ) return null

  return {
    id,
    repositoryPath,
    projectPath,
    targetBranch,
    savedSha,
    productionCommitSha,
    replacementCommitSha,
    sourceBranches: stringList(value.sourceBranches),
    landingIds: stringList(value.landingIds),
    sourceProviders: stringList(value.sourceProviders),
    turnIds: stringList(value.turnIds),
    turnIdentityProof: TURN_IDENTITY_PROOFS.has(value.turnIdentityProof)
      ? value.turnIdentityProof
      : null,
    productionAncestryVerified: value.productionAncestryVerified === true,
    landingState: LANDING_STATES.has(value.landingState) ? value.landingState : null,
    deliveryTarget: DELIVERY_TARGETS.has(value.deliveryTarget) ? value.deliveryTarget : 'production',
    description: text(value.description, 240),
    state: value.state,
    deploymentProvider: text(value.deploymentProvider, 64),
    deploymentId: text(value.deploymentId, 256),
    deploymentUrl: text(value.deploymentUrl, 2_048),
    deploymentDashboardUrl: text(value.deploymentDashboardUrl, 2_048),
    failureCode: text(value.failureCode, 256),
    failureMessage: text(value.failureMessage, 4_096),
    failureLog: text(value.failureLog, MAX_TEXT),
    repairState: ['idle', 'manual', 'running', 'waiting', 'unavailable'].includes(value.repairState)
      ? value.repairState
      : 'idle',
    repairJobId: text(value.repairJobId, 160),
    repairProvider: text(value.repairProvider, 128),
    repairAttempts: Number.isSafeInteger(value.repairAttempts) && value.repairAttempts >= 0
      ? value.repairAttempts
      : 0,
    attemptedProviders: stringList(value.attemptedProviders, 32),
    nextActionAt: date(value.nextActionAt),
    lastRepairError: text(value.lastRepairError, 4_096),
    productionAt: date(value.productionAt),
    createdAt,
    updatedAt,
  }
}

function decode(raw) {
  try {
    const envelope = JSON.parse(raw)
    if (envelope?.version !== JOURNAL_VERSION || typeof envelope.payload !== 'object') return null
    if (envelope.checksum !== checksum(envelope.payload) || !Array.isArray(envelope.payload.records)) return null
    const records = envelope.payload.records.map(normalize).filter(Boolean)
    if (records.length !== envelope.payload.records.length) return null
    return {
      revision: Number.isSafeInteger(envelope.payload.revision) ? envelope.payload.revision : 0,
      records,
    }
  } catch {
    return null
  }
}

async function syncDirectory(path) {
  let directory
  try {
    directory = await open(path, 'r')
    await directory.sync()
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) return
    throw error
  } finally {
    await directory?.close().catch(() => {})
  }
}

export class DeliveryJournal {
  constructor(options = {}) {
    if (typeof options.filePath !== 'string' || !isAbsolute(options.filePath)) {
      throw new TypeError('An absolute delivery-journal file path is required.')
    }
    this.filePath = options.filePath
    this.stagingPath = `${options.filePath}.staging`
    this.backupPath = `${options.filePath}.backup`
    this.clock = options.clock ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
    this.records = []
    this.revision = 0
    this.loaded = false
    this.writeChain = Promise.resolve()
  }

  list() {
    return this.#serialize(async () => {
      await this.#load()
      return this.records.map((record) => ({ ...record, sourceBranches: [...record.sourceBranches], landingIds: [...record.landingIds], sourceProviders: [...record.sourceProviders], turnIds: [...record.turnIds], attemptedProviders: [...record.attemptedProviders] }))
    })
  }

  upsertLanding(item, state = 'saved') {
    return this.#serialize(async () => {
      await this.#load()
      const index = this.records.findIndex((record) => (
        record.repositoryPath === item.repositoryPath
        && record.targetBranch === item.targetBranch
        && record.savedSha === String(item.savedSha ?? '').toLowerCase()
        && record.deliveryTarget === (DELIVERY_TARGETS.has(item.deliveryTarget) ? item.deliveryTarget : 'production')
      ))
      const now = this.clock().toISOString()
      const current = this.records[index]
      const stateOrder = ['saved', 'landing', 'pushed', 'building', 'failed', 'repairing', 'production']
      const requestedState = STATES.has(state) ? state : 'saved'
      const nextState = current && stateOrder.indexOf(current.state) > stateOrder.indexOf(requestedState)
        ? current.state
        : requestedState
      const record = normalize({
        ...(current ?? {}),
        id: current?.id ?? this.idFactory(),
        repositoryPath: item.repositoryPath,
        projectPath: item.projectPath,
        targetBranch: item.targetBranch,
        savedSha: item.savedSha,
        sourceBranches: [...(current?.sourceBranches ?? []), item.branch].filter(Boolean),
        landingIds: [...(current?.landingIds ?? []), item.id].filter(Boolean),
        sourceProviders: [...(current?.sourceProviders ?? []), item.provider].filter(Boolean),
        turnIds: [...(current?.turnIds ?? []), item.turnId].filter(Boolean),
        turnIdentityProof: current?.turnIdentityProof
          ?? item.turnIdentityProof
          ?? (item.turnId ? 'captured' : null),
        productionAncestryVerified: current?.productionAncestryVerified === true,
        landingState: item.state,
        deliveryTarget: item.deliveryTarget,
        state: nextState,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      })
      if (!record) throw new TypeError('Delivery landing metadata is incomplete or invalid.')
      const next = [...this.records]
      if (index < 0) next.push(record)
      else next[index] = record
      await this.#save(next)
      return { ...record }
    })
  }

  update(id, patch = {}) {
    return this.#serialize(async () => {
      await this.#load()
      const index = this.records.findIndex((record) => record.id === id)
      if (index < 0) return null
      const updated = normalize({
        ...this.records[index],
        ...patch,
        id,
        updatedAt: this.clock().toISOString(),
      })
      if (!updated) throw new TypeError('Delivery journal update is invalid.')
      const next = [...this.records]
      next[index] = updated
      await this.#save(next)
      return { ...updated }
    })
  }

  #serialize(operation) {
    const result = this.writeChain.then(operation, operation)
    this.writeChain = result.catch(() => {})
    return result
  }

  async #load() {
    if (this.loaded) return
    const candidates = await Promise.all([this.filePath, this.stagingPath, this.backupPath].map(async (path) => {
      try { return { path, decoded: decode(await readFile(path, 'utf8')), exists: true } } catch (error) { return { path, decoded: null, exists: error?.code !== 'ENOENT' } }
    }))
    const selected = candidates.filter((candidate) => candidate.decoded)
      .sort((left, right) => right.decoded.revision - left.decoded.revision)[0]
    if (!selected && candidates.some((candidate) => candidate.exists)) {
      throw new Error('The production-delivery journal is corrupt or unreadable. Ensync stopped delivery repair rather than losing its incident history.')
    }
    this.records = selected?.decoded.records ?? []
    this.revision = selected?.decoded.revision ?? 0
    this.loaded = true
    if (selected && selected.path !== this.filePath) await this.#save(this.records)
  }

  async #save(records) {
    const retained = [...records]
      .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
      .slice(-MAX_RECORDS)
    const payload = {
      revision: this.revision + 1,
      savedAt: this.clock().toISOString(),
      records: retained,
    }
    const envelope = JSON.stringify({ version: JOURNAL_VERSION, checksum: checksum(payload), payload })
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const staging = await open(this.stagingPath, 'w', 0o600)
    try {
      await staging.writeFile(envelope, 'utf8')
      await staging.sync()
    } finally {
      await staging.close()
    }
    try { await chmod(this.stagingPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
    await rm(this.backupPath, { force: true })
    try { await rename(this.filePath, this.backupPath) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await rename(this.stagingPath, this.filePath)
    await syncDirectory(dirname(this.filePath))
    this.records = retained
    this.revision = payload.revision
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

const JOURNAL_VERSION = 1
const MAX_TERMINAL_ITEMS = 200
const MAX_ERROR_LENGTH = 4_096
const STATES = new Set(['queued', 'integrating', 'retry', 'landed'])

function checksum(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function boundedString(value, maximum) {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maximum)
    : null
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function normalizeItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = boundedString(value.id, 160)
  const repositoryPath = boundedString(value.repositoryPath, 8_192)
  const commonGitDirectory = boundedString(value.commonGitDirectory, 8_192)
  const projectPath = boundedString(value.projectPath, 8_192)
  const workspacePath = boundedString(value.workspacePath, 8_192)
  const branch = boundedString(value.branch, 512)
  const savedSha = boundedString(value.savedSha, 64)?.toLowerCase()
  const targetBranch = boundedString(value.targetBranch, 512)
  const targetBaseSha = boundedString(value.targetBaseSha, 64)?.toLowerCase()
  const provider = boundedString(value.provider, 128)
  const createdAt = validDate(value.createdAt)
  const updatedAt = validDate(value.updatedAt)
  if (
    !id
    || !repositoryPath
    || !projectPath
    || !workspacePath
    || ![repositoryPath, projectPath, workspacePath].every(isAbsolute)
    || (commonGitDirectory !== null && !isAbsolute(commonGitDirectory))
    || !branch
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(savedSha ?? '')
    || ((targetBranch === null) !== (targetBaseSha === undefined || targetBaseSha === null))
    || (targetBaseSha !== undefined && targetBaseSha !== null
      && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(targetBaseSha))
    || !provider
    || !Number.isSafeInteger(value.completionSequence)
    || value.completionSequence < 1
    || !STATES.has(value.state)
    || !Number.isSafeInteger(value.attempts)
    || value.attempts < 0
    || !createdAt
    || !updatedAt
  ) return null
  return {
    id,
    repositoryPath,
    commonGitDirectory,
    projectPath,
    workspacePath,
    branch,
    savedSha,
    targetBranch,
    targetBaseSha: targetBaseSha ?? null,
    provider,
    completionSequence: value.completionSequence,
    state: value.state,
    attempts: value.attempts,
    createdAt,
    updatedAt,
    error: value.error === null ? null : boundedString(value.error, MAX_ERROR_LENGTH),
  }
}

function decode(value) {
  try {
    const envelope = JSON.parse(value)
    if (envelope?.version !== JOURNAL_VERSION || typeof envelope.payload !== 'object') return null
    if (envelope.checksum !== checksum(envelope.payload)) return null
    if (!Array.isArray(envelope.payload.items)) return null
    const items = envelope.payload.items.map(normalizeItem).filter(Boolean)
    if (items.length !== envelope.payload.items.length) return null
    return {
      revision: Number.isSafeInteger(envelope.payload.revision) ? envelope.payload.revision : 0,
      nextSequence: Number.isSafeInteger(envelope.payload.nextSequence)
        ? envelope.payload.nextSequence
        : 1,
      items,
    }
  } catch {
    return null
  }
}

function cloneItem(item) {
  return { ...item }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function syncDirectory(path) {
  let directory
  try {
    directory = await open(path, 'r')
    await directory.sync()
  } catch (error) {
    if (
      process.platform === 'win32'
      && ['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)
    ) return
    throw error
  } finally {
    await directory?.close().catch(() => {})
  }
}

export class LandingJournal {
  constructor(options = {}) {
    if (typeof options.filePath !== 'string' || !isAbsolute(options.filePath)) {
      throw new TypeError('An absolute landing-journal file path is required.')
    }
    this.filePath = options.filePath
    this.stagingPath = `${options.filePath}.staging`
    this.backupPath = `${options.filePath}.backup`
    this.clock = options.clock ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
    this.items = []
    this.revision = 0
    this.nextSequence = 1
    this.loaded = false
    this.writeChain = Promise.resolve()
  }

  load() {
    return this.#serialize(async () => {
      if (!this.loaded) await this.#loadFromDisk()
      return this.items.map(cloneItem)
    })
  }

  enqueue(input = {}) {
    return this.#serialize(async () => {
      if (!this.loaded) await this.#loadFromDisk()
      const now = this.clock().toISOString()
      const item = normalizeItem({
        id: this.idFactory(),
        repositoryPath: input.repositoryPath,
        commonGitDirectory: input.commonGitDirectory,
        projectPath: input.projectPath,
        workspacePath: input.workspacePath,
        branch: input.branch,
        savedSha: input.savedSha,
        targetBranch: input.targetBranch,
        targetBaseSha: input.targetBaseSha,
        provider: input.provider,
        completionSequence: this.nextSequence,
        state: 'queued',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        error: null,
      })
      if (!item || !item.commonGitDirectory || !item.targetBranch || !item.targetBaseSha) {
        throw new TypeError('Landing metadata is incomplete or invalid.')
      }
      await this.#save([...this.items, item], this.nextSequence + 1)
      return cloneItem(item)
    })
  }

  transition(id, expectedState, nextState, patch = {}) {
    return this.#serialize(async () => {
      if (!this.loaded) await this.#loadFromDisk()
      if (!STATES.has(expectedState) || !STATES.has(nextState)) {
        throw new TypeError('Landing state is invalid.')
      }
      const index = this.items.findIndex((item) => item.id === id)
      const current = this.items[index]
      if (!current || current.state !== expectedState) return null
      const attempts = patch.attempts === undefined ? current.attempts : patch.attempts
      if (!Number.isSafeInteger(attempts) || attempts < 0) throw new TypeError('Landing attempts must be a non-negative integer.')
      const updated = normalizeItem({
        ...current,
        state: nextState,
        attempts,
        error: patch.error === undefined
          ? current.error
          : patch.error === null
            ? null
            : String(patch.error).slice(0, MAX_ERROR_LENGTH),
        updatedAt: this.clock().toISOString(),
      })
      if (!updated) throw new TypeError('Landing transition is invalid.')
      const nextItems = [...this.items]
      nextItems[index] = updated
      await this.#save(nextItems, this.nextSequence)
      return cloneItem(updated)
    })
  }

  #serialize(operation) {
    const result = this.writeChain.then(operation, operation)
    this.writeChain = result.catch(() => {})
    return result
  }

  async #loadFromDisk() {
    const candidates = await Promise.all([
      this.filePath,
      this.stagingPath,
      this.backupPath,
    ].map(async (path) => {
      try {
        return { path, payload: decode(await readFile(path, 'utf8')), exists: true }
      } catch (error) {
        return { path, payload: null, exists: error?.code !== 'ENOENT' }
      }
    }))
    const selected = candidates
      .filter((candidate) => candidate.payload)
      .sort((left, right) => right.payload.revision - left.payload.revision)[0]
    if (!selected) {
      if (candidates.some((candidate) => candidate.exists)) {
        throw new Error('The automatic-landing journal is corrupt or unreadable. Ensync stopped landing so saved work is not discarded.')
      }
      this.items = []
      this.revision = 0
      this.nextSequence = 1
      this.loaded = true
      return
    }

    const recoveredItems = selected.payload.items
      .map((item) => item.state === 'integrating'
        ? {
            ...item,
            state: 'queued',
            updatedAt: this.clock().toISOString(),
            error: 'Integration was interrupted and will resume automatically.',
          }
        : item)
      .sort((left, right) => left.completionSequence - right.completionSequence)
    const sequenceFloor = recoveredItems.reduce(
      (maximum, item) => Math.max(maximum, item.completionSequence + 1),
      1,
    )
    const recoveredNextSequence = Math.max(selected.payload.nextSequence, sequenceFloor)

    const recoveredIntegration = recoveredItems.some((item, index) => (
      selected.payload.items[index]?.state === 'integrating' && item.state === 'queued'
    ))
    if (selected.path !== this.filePath || recoveredIntegration) {
      await this.#save(recoveredItems, recoveredNextSequence, selected.payload.revision)
    } else {
      this.items = recoveredItems
      this.revision = selected.payload.revision
      this.nextSequence = recoveredNextSequence
    }
    this.loaded = true
  }

  async #save(candidateItems, candidateNextSequence, baseRevision = this.revision) {
    const active = candidateItems.filter((item) => item.state !== 'landed')
    const terminal = candidateItems
      .filter((item) => item.state === 'landed')
      .slice(-MAX_TERMINAL_ITEMS)
    const retainedItems = [...active, ...terminal]
      .sort((left, right) => left.completionSequence - right.completionSequence)
    const payload = {
      revision: baseRevision + 1,
      savedAt: this.clock().toISOString(),
      nextSequence: candidateNextSequence,
      items: retainedItems,
    }
    const envelope = JSON.stringify({
      version: JOURNAL_VERSION,
      checksum: checksum(payload),
      payload,
    })
    const directoryPath = dirname(this.filePath)
    await mkdir(directoryPath, { recursive: true, mode: 0o700 })
    const staging = await open(this.stagingPath, 'w', 0o600)
    try {
      await staging.writeFile(envelope, { encoding: 'utf8' })
      await staging.sync()
    } finally {
      await staging.close()
    }
    try { await chmod(this.stagingPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
    if (await exists(this.filePath)) {
      await rm(this.backupPath, { force: true })
      await rename(this.filePath, this.backupPath)
    }
    await rename(this.stagingPath, this.filePath)
    await syncDirectory(directoryPath)
    this.items = retainedItems
    this.nextSequence = candidateNextSequence
    this.revision = payload.revision
  }
}

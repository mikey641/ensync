import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
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
  const projectPath = boundedString(value.projectPath, 8_192)
  const workspacePath = boundedString(value.workspacePath, 8_192)
  const branch = boundedString(value.branch, 512)
  const savedSha = boundedString(value.savedSha, 64)?.toLowerCase()
  const provider = boundedString(value.provider, 128)
  const createdAt = validDate(value.createdAt)
  const updatedAt = validDate(value.updatedAt)
  if (
    !id
    || !repositoryPath
    || !projectPath
    || !workspacePath
    || ![repositoryPath, projectPath, workspacePath].every(isAbsolute)
    || !branch
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(savedSha ?? '')
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
    projectPath,
    workspacePath,
    branch,
    savedSha,
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
        projectPath: input.projectPath,
        workspacePath: input.workspacePath,
        branch: input.branch,
        savedSha: input.savedSha,
        provider: input.provider,
        completionSequence: this.nextSequence,
        state: 'queued',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        error: null,
      })
      if (!item) throw new TypeError('Landing metadata is incomplete or invalid.')
      this.nextSequence += 1
      this.items.push(item)
      await this.#save()
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
      this.items[index] = updated
      await this.#save()
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
        return { path, payload: decode(await readFile(path, 'utf8')) }
      } catch {
        return { path, payload: null }
      }
    }))
    const selected = candidates
      .filter((candidate) => candidate.payload)
      .sort((left, right) => right.payload.revision - left.payload.revision)[0]
    if (!selected) {
      this.items = []
      this.revision = 0
      this.nextSequence = 1
      this.loaded = true
      return
    }

    this.items = selected.payload.items
      .map((item) => item.state === 'integrating'
        ? {
            ...item,
            state: 'queued',
            updatedAt: this.clock().toISOString(),
            error: 'Integration was interrupted and will resume automatically.',
          }
        : item)
      .sort((left, right) => left.completionSequence - right.completionSequence)
    this.revision = selected.payload.revision
    const sequenceFloor = this.items.reduce(
      (maximum, item) => Math.max(maximum, item.completionSequence + 1),
      1,
    )
    this.nextSequence = Math.max(selected.payload.nextSequence, sequenceFloor)
    this.loaded = true

    const recoveredIntegration = this.items.some((item, index) => (
      selected.payload.items[index]?.state === 'integrating' && item.state === 'queued'
    ))
    if (selected.path !== this.filePath || recoveredIntegration) await this.#save()
  }

  async #save() {
    const active = this.items.filter((item) => item.state !== 'landed')
    const terminal = this.items
      .filter((item) => item.state === 'landed')
      .slice(-MAX_TERMINAL_ITEMS)
    this.items = [...active, ...terminal]
      .sort((left, right) => left.completionSequence - right.completionSequence)
    const payload = {
      revision: this.revision + 1,
      savedAt: this.clock().toISOString(),
      nextSequence: this.nextSequence,
      items: this.items,
    }
    const envelope = JSON.stringify({
      version: JOURNAL_VERSION,
      checksum: checksum(payload),
      payload,
    })
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    await writeFile(this.stagingPath, envelope, { encoding: 'utf8', mode: 0o600 })
    try { await chmod(this.stagingPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
    if (await exists(this.filePath)) {
      await rm(this.backupPath, { force: true })
      await rename(this.filePath, this.backupPath)
    }
    await rename(this.stagingPath, this.filePath)
    this.revision = payload.revision
  }
}

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const JOURNAL_VERSION = 1

function checksum(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function decode(value) {
  try {
    const envelope = JSON.parse(value)
    if (envelope?.version !== JOURNAL_VERSION || !Array.isArray(envelope.payload?.jobs)) return null
    if (typeof envelope.checksum !== 'string' || envelope.checksum !== checksum(envelope.payload)) return null
    return envelope.payload
  } catch {
    return null
  }
}

function readCandidate(path) {
  try {
    return decode(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Checksummed, bounded metadata/event storage for Host-owned jobs. Callers
 * provide already-redacted public events; prompts and raw provider streams are
 * deliberately never part of this file.
 */
export class ChatJobJournal {
  constructor(options = {}) {
    if (typeof options.filePath !== 'string' || !options.filePath) {
      throw new TypeError('A chat-job journal file path is required.')
    }
    this.filePath = options.filePath
    this.stagingPath = `${options.filePath}.staging`
    this.backupPath = `${options.filePath}.backup`
    this.revision = 0
  }

  load() {
    const candidates = [this.filePath, this.stagingPath, this.backupPath]
      .map((path) => ({ path, payload: readCandidate(path) }))
      .filter((item) => item.payload)
      .sort((left, right) => (right.payload.revision ?? 0) - (left.payload.revision ?? 0))
    const selected = candidates[0]?.payload
    this.revision = Number.isSafeInteger(selected?.revision) ? selected.revision : 0
    return selected?.jobs ?? []
  }

  save(jobs) {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const payload = {
      revision: this.revision + 1,
      savedAt: new Date().toISOString(),
      jobs,
    }
    const envelope = JSON.stringify({
      version: JOURNAL_VERSION,
      checksum: checksum(payload),
      payload,
    })
    writeFileSync(this.stagingPath, envelope, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(this.stagingPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
    if (existsSync(this.filePath)) {
      rmSync(this.backupPath, { force: true })
      renameSync(this.filePath, this.backupPath)
    }
    renameSync(this.stagingPath, this.filePath)
    this.revision = payload.revision
    return payload
  }
}

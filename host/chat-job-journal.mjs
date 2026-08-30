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

import { processIsLiveSince } from './process-liveness.mjs'

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

export class ChatJobJournalInUseError extends Error {
  constructor() {
    super('Another live Ensync Host owns the provider-job journal. The competing Host was not allowed to reconcile or overwrite its jobs.')
    this.name = 'ChatJobJournalInUseError'
    this.code = 'chat_job_journal_in_use'
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
    this.writer = options.writer && typeof options.writer.instanceId === 'string'
      && Number.isInteger(options.writer.pid) && options.writer.pid > 0
      ? { instanceId: options.writer.instanceId, pid: options.writer.pid }
      : null
  }

  // The writer's PID is only evidence while it still names the process that
  // saved the file. After a reboot the operating system reissues that PID to an
  // unrelated daemon, and a liveness check alone would then fence every later
  // Host out of its own journal. savedAt dates the claim, so a PID whose
  // current owner started afterwards is a recycled one.
  #assertWriter(payload) {
    const writer = payload?.writer
    if (!this.writer || !writer || writer.instanceId === this.writer.instanceId) return
    const savedAtMs = Date.parse(payload?.savedAt)
    if (processIsLiveSince(writer.pid, savedAtMs)) throw new ChatJobJournalInUseError()
  }

  load() {
    const candidates = [this.filePath, this.stagingPath, this.backupPath]
      .map((path) => ({ path, payload: readCandidate(path) }))
      .filter((item) => item.payload)
      .sort((left, right) => (right.payload.revision ?? 0) - (left.payload.revision ?? 0))
    const selected = candidates[0]?.payload
    this.#assertWriter(selected)
    this.revision = Number.isSafeInteger(selected?.revision) ? selected.revision : 0
    return selected?.jobs ?? []
  }

  save(jobs) {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const latest = [this.filePath, this.stagingPath, this.backupPath]
      .map(readCandidate)
      .filter(Boolean)
      .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0]
    this.#assertWriter(latest)
    if (Number.isSafeInteger(latest?.revision)) this.revision = Math.max(this.revision, latest.revision)
    const payload = {
      revision: this.revision + 1,
      savedAt: new Date().toISOString(),
      ...(this.writer ? { writer: this.writer } : {}),
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

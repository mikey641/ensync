import { randomUUID } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { ChatRunError } from './chat.mjs'

const MAX_PROBE_COUNT = 64
const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_ATTACHMENT_NAME_LENGTH = 128

export const MAX_STORED_ATTACHMENT_BYTES = DEFAULT_MAX_ATTACHMENT_BYTES

async function pathOpensForReading(path) {
  try {
    const handle = await open(path, 'r')
    await handle.close()
    return true
  } catch {
    return false
  }
}

// stat() passes on macOS TCC-protected files (screenshot drag temp dirs, for
// example) while open() fails, so readability must be probed with a real open
// in the same privilege domain that later runs the agent CLIs.
export async function probeAttachmentPaths(paths) {
  if (!Array.isArray(paths) || paths.length > MAX_PROBE_COUNT) {
    throw new ChatRunError(
      'invalid_attachments',
      `Probe no more than ${MAX_PROBE_COUNT} attachment paths at once.`,
      413,
    )
  }
  const results = []
  for (const path of paths) {
    if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
      throw new ChatRunError('invalid_attachment', 'Every probed attachment path must be absolute.')
    }
    results.push({ path, readable: await pathOpensForReading(path) })
  }
  return { results }
}

function sanitizedAttachmentName(name) {
  const withoutDirectories = typeof name === 'string' ? basename(name.trim()) : ''
  const safe = withoutDirectories
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^[.\s-]+/, '')
    .slice(-MAX_ATTACHMENT_NAME_LENGTH)
  if (!safe) {
    throw new ChatRunError('invalid_attachment', 'Attached files need a usable file name.')
  }
  return safe
}

export class ChatAttachmentStore {
  #rootPath
  #maxBytes

  constructor(options = {}) {
    const rootPath = options.rootPath ?? join(homedir(), '.ensync', 'chat-attachments-v1')
    if (typeof rootPath !== 'string' || !isAbsolute(rootPath)) {
      throw new Error('The chat attachment root must be an absolute path.')
    }
    this.#rootPath = resolve(rootPath)
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
  }

  async store({ name, bytes } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new ChatRunError('invalid_attachment', 'Attachment uploads need non-empty binary file content.')
    }
    if (bytes.length > this.#maxBytes) {
      throw new ChatRunError(
        'invalid_attachment',
        `Attached files must stay under ${Math.floor(this.#maxBytes / (1024 * 1024))} MB for Ensync to store a readable copy.`,
        413,
      )
    }
    const safeName = sanitizedAttachmentName(name)
    const directory = join(this.#rootPath, randomUUID())
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, safeName)
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    return { path, name: safeName }
  }
}

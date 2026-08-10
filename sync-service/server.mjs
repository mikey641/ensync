import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,31}$/
const MAX_REQUEST_BYTES = 12 * 1024 * 1024
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000

class SyncServiceError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

function normalizedUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!USERNAME_PATTERN.test(username)) {
    throw new SyncServiceError('username_invalid', 'Use 3–32 lowercase letters, numbers, dots, dashes, or underscores.', 400)
  }
  return username
}

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
    throw new SyncServiceError('password_invalid', 'Use a password between 12 and 256 characters.', 400)
  }
  return value
}

function validDocument(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.version === 1
    && value.algorithm === 'aes-256-gcm'
    && typeof value.iv === 'string' && value.iv.length <= 64
    && typeof value.tag === 'string' && value.tag.length <= 64
    && typeof value.ciphertext === 'string' && value.ciphertext.length <= 11 * 1024 * 1024,
  )
}

async function passwordHash(password, salt) {
  return (await scrypt(password, Buffer.from(salt, 'base64url'), 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })).toString('base64url')
}

function emptyData() {
  return { version: 1, accounts: {} }
}

export class MemorySyncStore {
  constructor(initial = emptyData()) {
    this.data = structuredClone(initial)
  }

  read() {
    return structuredClone(this.data)
  }

  write(data) {
    this.data = structuredClone(data)
  }
}

export class FileSyncStore {
  constructor(filePath) {
    this.filePath = resolve(filePath)
  }

  read() {
    try {
      const value = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return value?.version === 1 && value.accounts && typeof value.accounts === 'object'
        ? value
        : emptyData()
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyData()
      throw error
    }
  }

  write(data) {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const staging = `${this.filePath}.staging`
    writeFileSync(staging, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
    chmodSync(staging, 0o600)
    renameSync(staging, this.filePath)
  }
}

function json(response, status, payload) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

function body(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new SyncServiceError('request_too_large', 'The sync request is too large.', 413))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new SyncServiceError('invalid_json', 'The request body must be valid JSON.', 400))
      }
    })
    request.on('error', reject)
  })
}

function sessionKey(token) {
  return createHash('sha256').update(token).digest('base64url')
}

export function createEnsyncSyncServer(options = {}) {
  const store = options.store ?? new MemorySyncStore()
  const sessions = new Map()

  function createSession(username) {
    const token = randomBytes(32).toString('base64url')
    sessions.set(sessionKey(token), { username, expiresAt: Date.now() + SESSION_LIFETIME_MS })
    return token
  }

  function authenticate(request) {
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new SyncServiceError('login_required', 'Sign in to synchronize conversations.', 401)
    }
    const key = sessionKey(header.slice(7))
    const session = sessions.get(key)
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(key)
      throw new SyncServiceError('session_expired', 'The account session expired. Sign in again.', 401)
    }
    return { key, ...session }
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    try {
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        return json(response, 200, { service: 'ensync-sync', version: 1 })
      }

      if (request.method === 'POST' && url.pathname === '/v1/accounts') {
        const input = await body(request)
        const username = normalizedUsername(input.username)
        const password = validPassword(input.password)
        const data = store.read()
        if (data.accounts[username]) throw new SyncServiceError('username_taken', 'That username is already registered.', 409)
        const passwordSalt = randomBytes(16).toString('base64url')
        const encryptionSalt = randomBytes(16).toString('base64url')
        data.accounts[username] = {
          passwordSalt,
          passwordHash: await passwordHash(password, passwordSalt),
          encryptionSalt,
          createdAt: new Date().toISOString(),
          workspace: null,
        }
        store.write(data)
        return json(response, 201, { username, token: createSession(username), encryptionSalt })
      }

      if (request.method === 'POST' && url.pathname === '/v1/sessions') {
        const input = await body(request)
        const username = normalizedUsername(input.username)
        const password = validPassword(input.password)
        const account = store.read().accounts[username]
        const supplied = await passwordHash(
          password,
          account?.passwordSalt ?? randomBytes(16).toString('base64url'),
        )
        const expected = account?.passwordHash ?? randomBytes(32).toString('base64url')
        const valid = Boolean(account) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
        if (!valid) throw new SyncServiceError('login_failed', 'The username or password is incorrect.', 401)
        return json(response, 200, { username, token: createSession(username), encryptionSalt: account.encryptionSalt })
      }

      if (request.method === 'DELETE' && url.pathname === '/v1/session') {
        const session = authenticate(request)
        sessions.delete(session.key)
        return json(response, 200, { authenticated: false })
      }

      if (request.method === 'GET' && url.pathname === '/v1/workspace') {
        const session = authenticate(request)
        const workspace = store.read().accounts[session.username]?.workspace ?? null
        return json(response, 200, workspace ?? { revision: 0, document: null, updatedAt: null })
      }

      if (request.method === 'PUT' && url.pathname === '/v1/workspace') {
        const session = authenticate(request)
        const input = await body(request)
        if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || !validDocument(input.document)) {
          throw new SyncServiceError('workspace_invalid', 'A valid encrypted workspace and base revision are required.', 400)
        }
        const data = store.read()
        const account = data.accounts[session.username]
        if (!account) throw new SyncServiceError('account_missing', 'The account no longer exists.', 401)
        const current = account.workspace ?? { revision: 0, document: null, updatedAt: null }
        if (input.baseRevision !== current.revision) {
          throw new SyncServiceError('sync_revision_conflict', 'Newer synchronized conversations are available.', 409, current)
        }
        account.workspace = {
          revision: current.revision + 1,
          document: input.document,
          updatedAt: new Date().toISOString(),
        }
        store.write(data)
        return json(response, 200, account.workspace)
      }

      return json(response, 404, { error: 'Not found.', code: 'not_found' })
    } catch (error) {
      if (error instanceof SyncServiceError) {
        return json(response, error.status, {
          error: error.message,
          code: error.code,
          ...(error.details ?? {}),
        })
      }
      return json(response, 500, { error: 'Unexpected sync service error.', code: 'unexpected_sync_error' })
    }
  })
}

const isEntry = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isEntry) {
  const port = Number.parseInt(process.env.ENSYNC_SYNC_PORT ?? '43122', 10)
  const host = process.env.ENSYNC_SYNC_HOST ?? '127.0.0.1'
  const filePath = process.env.ENSYNC_SYNC_DATA_FILE ?? resolve('.ensync-sync-data.json')
  const server = createEnsyncSyncServer({ store: new FileSyncStore(filePath) })
  server.listen(port, host, () => {
    console.log(`Ensync Sync listening on http://${host}:${port}`)
  })
}

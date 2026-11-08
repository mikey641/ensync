import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// OS-backed secret storage for the detached Host. The Host is a plain Node
// process (no Electron safeStorage), so it uses the user's login keychain on
// macOS and user-scoped DPAPI on Windows. Anything else reports itself
// unavailable and callers must fail closed rather than write plaintext.

const KEYCHAIN_SERVICE = 'Ensync Host'
const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_SECRET_CHARACTERS = 16 * 1024

export class HostSecretStoreError extends Error {
  constructor(code, message, status = 503) {
    super(message)
    this.name = 'HostSecretStoreError'
    this.code = code
    this.status = status
  }
}

function validName(name) {
  if (typeof name !== 'string' || !SECRET_NAME_PATTERN.test(name)) {
    throw new HostSecretStoreError('secret_name_invalid', 'The secret name is invalid.', 400)
  }
  return name
}

function runProcess(command, args, input) {
  return new Promise((resolveRun) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolveRun({ code: -1, stdout: '', stderr: 'spawn failed' })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.stdout.on('data', (chunk) => { if (stdout.length < 64 * 1024) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < 16 * 1024) stderr += chunk })
    child.on('error', () => {
      clearTimeout(timer)
      resolveRun({ code: -1, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/**
 * macOS login keychain through `security -i`, so the secret travels over stdin
 * instead of the process argument list. Values are base64-encoded so the
 * interactive parser never sees quotes or backslashes.
 */
function macosKeychainBackend(run) {
  const account = (name) => `ensync-host.${name}`
  return {
    kind: 'macos_keychain',
    async get(name) {
      const result = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account(name), '-w'])
      if (result.code !== 0) return null
      const encoded = result.stdout.trim()
      return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null
    },
    async set(name, value) {
      const encoded = Buffer.from(value, 'utf8').toString('base64')
      const command = `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account(name)}" -w "${encoded}"\n`
      const result = await run('/usr/bin/security', ['-i'], command)
      if (result.code !== 0 || /error/i.test(result.stderr)) {
        throw new HostSecretStoreError('secret_storage_failed', 'The macOS keychain did not accept the Ensync credential.')
      }
    },
    async delete(name) {
      await run('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account(name)])
    },
  }
}

const DPAPI_PROTECT = [
  '-NoProfile', '-NonInteractive', '-Command',
  'Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); '
    + '$b=[Convert]::FromBase64String($in); '
    + '$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); '
    + '[Console]::Out.Write([Convert]::ToBase64String($p))',
]
const DPAPI_UNPROTECT = [
  '-NoProfile', '-NonInteractive', '-Command',
  'Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); '
    + '$b=[Convert]::FromBase64String($in); '
    + '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); '
    + '[Console]::Out.Write([Convert]::ToBase64String($p))',
]

/** Windows: user-scoped DPAPI ciphertext kept in a user-only JSON file. */
function windowsDpapiBackend(run, filePath) {
  const readAll = async () => {
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8'))
      return value?.format === 'ensync-host-secrets' && value.version === 1 && value.secrets && typeof value.secrets === 'object'
        ? value.secrets
        : {}
    } catch {
      return {}
    }
  }
  const writeAll = async (secrets) => {
    await mkdir(dirname(filePath), { recursive: true })
    const staging = `${filePath}.staging`
    await writeFile(staging, JSON.stringify({ format: 'ensync-host-secrets', version: 1, secrets }), { encoding: 'utf8', mode: 0o600 })
    await rename(staging, filePath)
  }
  return {
    kind: 'windows_dpapi',
    async get(name) {
      const cipher = (await readAll())[name]
      if (typeof cipher !== 'string') return null
      const result = await run('powershell.exe', DPAPI_UNPROTECT, cipher)
      if (result.code !== 0 || !result.stdout.trim()) return null
      return Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
    },
    async set(name, value) {
      const result = await run('powershell.exe', DPAPI_PROTECT, Buffer.from(value, 'utf8').toString('base64'))
      if (result.code !== 0 || !result.stdout.trim()) {
        throw new HostSecretStoreError('secret_storage_failed', 'Windows data protection did not accept the Ensync credential.')
      }
      const secrets = await readAll()
      secrets[name] = result.stdout.trim()
      await writeAll(secrets)
    },
    async delete(name) {
      const secrets = await readAll()
      if (!(name in secrets)) return
      delete secrets[name]
      await writeAll(secrets)
    },
  }
}

export class HostSecretStore {
  #backend

  constructor(options = {}) {
    if ('backend' in options) {
      this.#backend = options.backend ?? null
      return
    }
    const platform = options.platform ?? process.platform
    const run = options.run ?? runProcess
    if (platform === 'darwin') this.#backend = macosKeychainBackend(run)
    else if (platform === 'win32' && typeof options.filePath === 'string') this.#backend = windowsDpapiBackend(run, options.filePath)
    else this.#backend = null
  }

  /** `macos_keychain`, `windows_dpapi`, a test backend's kind, or `unavailable`. */
  get kind() {
    return this.#backend?.kind ?? 'unavailable'
  }

  available() {
    return Boolean(this.#backend)
  }

  async get(name) {
    validName(name)
    if (!this.#backend) return null
    return this.#backend.get(name)
  }

  async set(name, value) {
    validName(name)
    if (typeof value !== 'string' || !value || value.length > MAX_SECRET_CHARACTERS) {
      throw new HostSecretStoreError('secret_value_invalid', 'The secret value is invalid.', 400)
    }
    if (!this.#backend) {
      throw new HostSecretStoreError(
        'secret_storage_unavailable',
        'This computer has no encrypted credential storage that Ensync Host can use.',
      )
    }
    await this.#backend.set(name, value)
  }

  async delete(name) {
    validName(name)
    if (!this.#backend) return
    await this.#backend.delete(name)
  }
}

/** In-memory backend for tests. */
export function memorySecretBackend(kind = 'memory') {
  const values = new Map()
  return {
    kind,
    values,
    async get(name) { return values.get(name) ?? null },
    async set(name, value) { values.set(name, value) },
    async delete(name) { values.delete(name) },
  }
}

export async function writePrivateJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  const staging = `${filePath}.staging`
  await writeFile(staging, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  try { await chmod(staging, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
  try {
    await rename(staging, filePath)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
    await rm(filePath, { force: true })
    await rename(staging, filePath)
  }
}

export async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_ERROR_TEXT = 4_096
const COMMAND_TIMEOUT_MS = 2 * 60_000

const PLATFORM_PACKAGES = Object.freeze({
  'darwin-arm64': '@nekocode/agent-worktree-darwin-arm64',
  'darwin-x64': '@nekocode/agent-worktree-darwin-x64',
  'linux-x64': '@nekocode/agent-worktree-linux-x64',
  'win32-x64': '@nekocode/agent-worktree-win32-x64',
})

function boundedText(value, maximum = MAX_ERROR_TEXT) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  if (text.length <= maximum) return text
  return `${text.slice(0, maximum)}\n[output truncated]`
}

async function canExecute(path, platform, accessImpl) {
  try {
    await accessImpl(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the pinned agent-worktree executable without consulting PATH. A
 * packaged Host finds Resources/tools/wt; source runs use npm's platform
 * package (or its .bin shim on POSIX).
 */
export async function resolveAgentWorktreeExecutable(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const accessImpl = options.access ?? access
  const sourceRoot = resolve(options.sourceRoot ?? dirname(dirname(fileURLToPath(import.meta.url))))
  const executableName = platform === 'win32' ? 'wt.exe' : 'wt'
  const explicit = env.ENSYNC_AGENT_WORKTREE_EXECUTABLE

  if (explicit) {
    if (isAbsolute(explicit) && await canExecute(explicit, platform, accessImpl)) return explicit
    throw new Error('The configured agent-worktree executable is unavailable.')
  }

  const candidates = [join(sourceRoot, 'tools', executableName)]
  const platformPackage = PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (platformPackage) {
    candidates.push(join(sourceRoot, 'node_modules', ...platformPackage.split('/'), 'bin', executableName))
  }
  if (platform !== 'win32') candidates.push(join(sourceRoot, 'node_modules', '.bin', 'wt'))

  for (const candidate of candidates) {
    if (await canExecute(candidate, platform, accessImpl)) return candidate
  }
  throw new Error(`The agent-worktree executable is unavailable for ${platform}-${arch}. Reinstall Ensync or run npm install.`)
}

export class AgentWorktreeCommandError extends Error {
  constructor(operation, message, details = {}) {
    super(message)
    this.name = 'AgentWorktreeCommandError'
    this.operation = operation
    this.exitCode = Number.isInteger(details.exitCode) ? details.exitCode : null
    this.stdout = boundedText(details.stdout)
    this.stderr = boundedText(details.stderr)
    this.cause = details.cause
  }
}

function requiredPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path.`)
  }
  return value
}

function requiredName(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty name.`)
  }
  return value
}

function strategy(value) {
  if (!['merge', 'rebase', 'squash'].includes(value)) throw new TypeError('Unsupported agent-worktree strategy.')
  return value
}

export class AgentWorktreeClient {
  constructor(options = {}) {
    this.executable = requiredPath(options.executable, 'agent-worktree executable')
    this.storagePath = requiredPath(
      options.storagePath ?? join(homedir(), '.ensync', 'agent-worktree'),
      'agent-worktree storage path',
    )
    this.run = options.run ?? execFile
    this.environment = { ...(options.env ?? process.env) }
    this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  }

  async list(repositoryPath) {
    const result = await this.#invoke('list', ['ls', '--json'], requiredPath(repositoryPath, 'repository path'))
    return this.#parseJson('list', result.stdout)
  }

  async create(input = {}) {
    const repositoryPath = requiredPath(input.repositoryPath, 'repository path')
    const branch = requiredName(input.branch, 'branch')
    const base = requiredName(input.base, 'base branch')
    await this.#invoke('create', ['new', '--base', base, '--', branch], repositoryPath)
    const listed = await this.list(repositoryPath)
    const created = Array.isArray(listed?.worktrees)
      ? listed.worktrees.find((worktree) => worktree?.branch === branch)
      : null
    if (!created || typeof created.path !== 'string') {
      throw new AgentWorktreeCommandError('create', `agent-worktree created ${branch} but did not report its path.`)
    }
    return created
  }

  async status(worktreePath) {
    const result = await this.#invoke('status', ['status', '--json'], requiredPath(worktreePath, 'worktree path'))
    return this.#parseJson('status', result.stdout)
  }

  async sync(input = {}) {
    const worktreePath = requiredPath(input.worktreePath, 'worktree path')
    const from = requiredName(input.from, 'source branch')
    const selectedStrategy = strategy(input.strategy ?? 'merge')
    return this.#invoke('sync', ['sync', '--strategy', selectedStrategy, '--from', from], worktreePath)
  }

  async continueSync(input = {}) {
    return this.#invoke('continueSync', ['sync', '--continue'], requiredPath(input.worktreePath, 'worktree path'))
  }

  async abortSync(input = {}) {
    return this.#invoke('abortSync', ['sync', '--abort'], requiredPath(input.worktreePath, 'worktree path'))
  }

  async merge(input = {}) {
    const worktreePath = requiredPath(input.worktreePath, 'worktree path')
    const into = requiredName(input.into, 'target branch')
    const selectedStrategy = strategy(input.strategy ?? 'merge')
    const args = ['merge', '--strategy', selectedStrategy, '--into', into]
    if (input.delete) args.push('--delete')
    if (input.skipHooks) args.push('--skip-hooks')
    try {
      return await this.#invoke('merge', args, worktreePath)
    } catch (error) {
      if (error instanceof AgentWorktreeCommandError && error.exitCode === 13) {
        return {
          disposition: 'conflict',
          exitCode: error.exitCode,
          stdout: error.stdout,
          stderr: error.stderr,
        }
      }
      throw error
    }
  }

  async remove(input = {}) {
    const repositoryPath = requiredPath(input.repositoryPath, 'repository path')
    const branch = requiredName(input.branch, 'branch')
    const args = ['rm']
    if (input.force) args.push('--force')
    args.push('--', branch)
    return this.#invoke('remove', args, repositoryPath)
  }

  async #invoke(operation, args, cwd) {
    try {
      const result = await this.run(this.executable, args, {
        cwd,
        encoding: 'utf8',
        env: {
          ...this.environment,
          AGENT_WORKTREE_DIR: this.storagePath,
        },
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        timeout: this.timeoutMs,
        windowsHide: true,
      })
      return {
        disposition: 'applied',
        exitCode: 0,
        stdout: boundedText(result?.stdout, MAX_OUTPUT_BYTES),
        stderr: boundedText(result?.stderr, MAX_OUTPUT_BYTES),
      }
    } catch (cause) {
      const exitCode = Number.isInteger(cause?.code) ? cause.code : null
      const detail = boundedText(cause?.stderr || cause?.message || 'unknown failure')
      throw new AgentWorktreeCommandError(
        operation,
        `agent-worktree ${operation} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${detail}`,
        { cause, exitCode, stdout: cause?.stdout, stderr: cause?.stderr },
      )
    }
  }

  #parseJson(operation, stdout) {
    try {
      const parsed = JSON.parse(stdout)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('expected an object')
      return parsed
    } catch (cause) {
      throw new AgentWorktreeCommandError(
        operation,
        `agent-worktree ${operation} returned invalid JSON.`,
        { cause, stdout },
      )
    }
  }
}

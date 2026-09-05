import { randomUUID } from 'node:crypto'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_ERROR_TEXT = 4_096
const MAX_COMMIT_MESSAGE = 16_384
const COMMAND_TIMEOUT_MS = 2 * 60_000
const TERMINATION_GRACE_MS = 1_000
const PINNED_VERSION = 'wt 0.13.6'
const PROJECT_CONFIG_NAME = '.agent-worktree.toml'
// Git for Windows and POSIX Git both treat /dev/null as a non-directory hook
// path. Unlike a user-writable "empty" directory, another agent process cannot
// populate it between verification and spawn.
const DISABLED_GIT_HOOKS_PATH = '/dev/null'
const SAFE_RUNTIME_CONFIG = `[general]
merge_strategy = "merge"
sync_strategy = "merge"
copy_files = []
submodules = false
submodule_jobs = 1

[hooks]
post_create = []
pre_merge = []
post_merge = []
`
const REFERENCE_TRANSACTION_HOOK = `#!/bin/sh
if test "$1" != "prepared"; then
  exit 0
fi
while IFS=' ' read -r old new ref
do
  if test "$ref" = "$ENSYNC_EXPECTED_REF"; then
    actual=$(git rev-parse --verify "$ref" 2>/dev/null) || exit 1
    if test "$actual" != "$ENSYNC_EXPECTED_OLD"; then
      exit 1
    fi
    printf '%s %s %s\\n' "$actual" "$new" "$ref" > "$ENSYNC_GUARD_RESULT" || exit 1
  fi
done
exit 0
`
const PREPARE_COMMIT_MESSAGE_HOOK = `#!/bin/sh
if test "$2" = "merge" && test -n "$ENSYNC_COMMIT_MESSAGE_FILE"; then
  cat "$ENSYNC_COMMIT_MESSAGE_FILE" > "$1" || exit 1
fi
exit 0
`

const PLATFORM_PACKAGES = Object.freeze({
  'darwin-arm64': '@nekocode/agent-worktree-darwin-arm64',
  'darwin-x64': '@nekocode/agent-worktree-darwin-x64',
  'linux-x64': '@nekocode/agent-worktree-linux-x64',
  'win32-x64': '@nekocode/agent-worktree-win32-x64',
})

async function terminateProcessTree(child, force, options = {}) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    await new Promise((resolveTermination) => {
      const killer = (options.spawn ?? spawn)('taskkill', [
        '/PID', String(child.pid), '/T', ...(force ? ['/F'] : []),
      ], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', resolveTermination)
      killer.once('close', resolveTermination)
    })
    return
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* close/error remains authoritative */ }
  }
}

/**
 * Execute the native adapter in its own POSIX process group (or a Windows
 * taskkill tree) so timeout/shutdown cannot leave a child Git mutation alive.
 */
export function runAgentWorktreeCommand(executable, args, options = {}) {
  const spawnProcess = options.spawn ?? spawn
  const platform = options.platform ?? process.platform
  const killTree = options.killTree ?? ((child, force) => terminateProcessTree(child, force, {
    platform,
    spawn: options.treeKillSpawn,
  }))
  const timeoutMs = options.timeout ?? COMMAND_TIMEOUT_MS
  const terminationGraceMs = options.terminationGraceMs ?? TERMINATION_GRACE_MS
  if (options.signal?.aborted) {
    const error = new Error('agent-worktree was stopped before starting.')
    error.name = 'AbortError'
    return Promise.reject(error)
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnProcess(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let stoppingError = null
    let processClosed = false
    let treeTerminated = false
    let exitCode = null
    let exitSignal = null
    let timer = null
    let forceTimer = null
    let settled = false

    const finish = () => {
      if (settled || !processClosed || (stoppingError && !treeTerminated)) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      options.signal?.removeEventListener('abort', onAbort)
      if (stoppingError) return rejectRun(stoppingError)
      if (exitCode === 0) return resolveRun({ stdout, stderr })
      const error = new Error(`agent-worktree exited with ${exitSignal ?? exitCode ?? 'an unknown status'}.`)
      error.code = exitCode
      error.stdout = stdout
      error.stderr = stderr
      rejectRun(error)
    }
    const stop = (error) => {
      if (stoppingError) return
      stoppingError = error
      clearTimeout(timer)
      void Promise.resolve(killTree(child, false)).catch(() => {})
      forceTimer = setTimeout(() => {
        void Promise.resolve(killTree(child, true)).catch(() => {}).finally(() => {
          treeTerminated = true
          finish()
        })
      }, terminationGraceMs)
    }
    const collect = (target, chunk) => {
      if (stoppingError) return target
      outputBytes += chunk.length
      if (outputBytes > (options.maxBuffer ?? MAX_OUTPUT_BYTES)) {
        const error = new Error('agent-worktree produced too much output.')
        error.code = 'ENOBUFS'
        stop(error)
        return target
      }
      return target + chunk.toString(options.encoding ?? 'utf8')
    }
    const onAbort = () => {
      const error = new Error('agent-worktree was stopped before completing.')
      error.name = 'AbortError'
      stop(error)
    }

    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk) })
    child.once('error', (error) => {
      if (!child.pid) {
        processClosed = true
        stoppingError = error
        treeTerminated = true
        finish()
      } else {
        stop(error)
      }
    })
    child.once('close', (code, signal) => {
      processClosed = true
      exitCode = code
      exitSignal = signal
      finish()
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    timer = setTimeout(() => {
      const error = new Error('agent-worktree timed out without completing.')
      error.code = 'ETIMEDOUT'
      stop(error)
    }, timeoutMs)
  })
}

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

async function verifySafeRuntimeConfig(configPath) {
  let information
  try {
    information = await lstat(configPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error('The Ensync agent-worktree config path is not a regular file.')
  }
  if (await readFile(configPath, 'utf8') !== SAFE_RUNTIME_CONFIG) {
    throw new Error('The Ensync agent-worktree config is not the pinned safe configuration.')
  }
  try { await chmod(configPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
  return true
}

async function prepareSafeRuntime(storagePath) {
  await mkdir(storagePath, { recursive: true, mode: 0o700 })
  const configPath = join(storagePath, 'config.toml')
  if (await verifySafeRuntimeConfig(configPath)) return

  // Publish a fully written immutable config with an exclusive hard link. Two
  // Host processes may prepare the same shared runtime concurrently; neither
  // ever removes or replaces the safe file beneath an already-running `wt`.
  const stagingPath = join(storagePath, `.config-${randomUUID()}.tmp`)
  await writeFile(stagingPath, SAFE_RUNTIME_CONFIG, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  try {
    try {
      await link(stagingPath, configPath)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  } finally {
    await rm(stagingPath, { force: true }).catch(() => {})
  }
  if (!(await verifySafeRuntimeConfig(configPath))) {
    throw new Error('The Ensync agent-worktree config could not be installed safely.')
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
  const inspectVersion = options.inspectVersion ?? execFile
  const sourceRoot = resolve(options.sourceRoot ?? dirname(dirname(fileURLToPath(import.meta.url))))
  const executableName = platform === 'win32' ? 'wt.exe' : 'wt'
  const candidates = [join(sourceRoot, 'tools', executableName)]
  const platformPackage = PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (platformPackage) {
    candidates.push(join(sourceRoot, 'node_modules', ...platformPackage.split('/'), 'bin', executableName))
  }
  if (platform !== 'win32') candidates.push(join(sourceRoot, 'node_modules', '.bin', 'wt'))

  for (const candidate of candidates) {
    if (!(await canExecute(candidate, platform, accessImpl))) continue
    try {
      const result = await inspectVersion(candidate, ['--version'], {
        encoding: 'utf8',
        env,
        maxBuffer: 16 * 1024,
        shell: false,
        timeout: 5_000,
        windowsHide: true,
      })
      if (String(result?.stdout ?? '').trim() === PINNED_VERSION) return candidate
    } catch {
      // A candidate that cannot prove the pinned version is never executed for work.
    }
  }
  throw new Error(`The pinned agent-worktree ${PINNED_VERSION.slice(3)} executable is unavailable for ${platform}-${arch}. Reinstall Ensync or run npm install.`)
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

function identityEnvironment(identity) {
  if (identity === undefined) return {}
  const name = requiredName(identity?.name, 'Git identity name')
  const email = requiredName(identity?.email, 'Git identity email')
  if (/\r|\n/.test(name) || /\r|\n/.test(email)) throw new TypeError('Git identity cannot contain line breaks.')
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  }
}

function withoutCommandConfig(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => (
    key !== 'GIT_CONFIG_COUNT'
    && key !== 'GIT_CONFIG_PARAMETERS'
    && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
  )))
}

function strategy(value) {
  if (!['merge', 'rebase', 'squash'].includes(value)) throw new TypeError('Unsupported agent-worktree strategy.')
  return value
}

function requiredCommit(value, label) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value ?? '')) {
    throw new TypeError(`${label} must be an exact Git commit ID.`)
  }
  return value.toLowerCase()
}

function optionalCommitMessage(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError('merge commit message must be non-empty text without NUL bytes.')
  }
  return value.replace(/\r\n?/g, '\n').trim().slice(0, MAX_COMMIT_MESSAGE)
}

async function withPublicationGuard(details, invoke) {
  const expectedHead = requiredCommit(details.expectedHead, 'expected target head')
  const targetRef = `refs/heads/${requiredName(details.into, 'target branch')}`
  const commitMessage = optionalCommitMessage(details.commitMessage)
  const guardsPath = join(details.storagePath, 'publication-guards')
  const guardPath = join(guardsPath, randomUUID())
  const hookPath = join(guardPath, 'reference-transaction')
  const messageHookPath = join(guardPath, 'prepare-commit-msg')
  const messagePath = join(guardPath, 'merge-message')
  const resultPath = join(guardPath, 'result')
  await mkdir(guardsPath, { recursive: true, mode: 0o700 })
  await mkdir(guardPath, { mode: 0o700 })
  try {
    await writeFile(hookPath, REFERENCE_TRANSACTION_HOOK, {
      encoding: 'utf8',
      mode: 0o700,
      flag: 'wx',
    })
    try { await chmod(hookPath, 0o700) } catch { /* Git for Windows executes hooks through its shell. */ }
    if (commitMessage) {
      await writeFile(messagePath, `${commitMessage}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      await writeFile(messageHookPath, PREPARE_COMMIT_MESSAGE_HOOK, {
        encoding: 'utf8',
        mode: 0o700,
        flag: 'wx',
      })
      try { await chmod(messagePath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
      try { await chmod(messageHookPath, 0o700) } catch { /* Git for Windows executes hooks through its shell. */ }
    }
    const result = await invoke({
      GIT_CONFIG_VALUE_0: guardPath,
      ENSYNC_EXPECTED_REF: targetRef,
      ENSYNC_EXPECTED_OLD: expectedHead,
      ENSYNC_GUARD_RESULT: resultPath,
      ...(commitMessage ? { ENSYNC_COMMIT_MESSAGE_FILE: messagePath } : {}),
    })
    let record = ''
    try {
      const information = await lstat(resultPath)
      if (!information.isFile() || information.isSymbolicLink()) throw new Error('unsafe guard result')
      record = (await readFile(resultPath, 'utf8')).trim()
    } catch {
      throw new AgentWorktreeCommandError(
        'publicationGuard',
        'Git did not prove that the automatic landing target retained its expected head.',
      )
    }
    const [oldHead, newHead, changedRef, ...extra] = record.split(' ')
    if (
      oldHead !== expectedHead
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(newHead ?? '')
      || changedRef !== targetRef
      || extra.length > 0
    ) {
      throw new AgentWorktreeCommandError(
        'publicationGuard',
        'Git reported an invalid automatic landing reference transaction.',
      )
    }
    return result
  } finally {
    await rm(guardPath, { recursive: true, force: true }).catch(() => {})
  }
}

export class AgentWorktreeClient {
  constructor(options = {}) {
    this.executable = requiredPath(options.executable, 'agent-worktree executable')
    this.storagePath = requiredPath(
      options.storagePath ?? join(homedir(), '.ensync', 'agent-worktree'),
      'agent-worktree storage path',
    )
    this.run = options.run ?? runAgentWorktreeCommand
    this.environment = { ...(options.env ?? process.env) }
    this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
    this.prepareRuntime = options.prepareRuntime ?? prepareSafeRuntime
    this.projectConfigAccess = options.projectConfigAccess ?? access
    this.withPublicationGuard = options.withPublicationGuard ?? withPublicationGuard
    this.invokeChain = Promise.resolve()
  }

  async list(repositoryPath, options = {}) {
    const result = await this.#invoke(
      'list',
      ['ls', '--json'],
      requiredPath(repositoryPath, 'repository path'),
      undefined,
      {},
      undefined,
      options.signal,
    )
    return this.#parseJson('list', result.stdout)
  }

  async create(input = {}) {
    const repositoryPath = requiredPath(input.repositoryPath, 'repository path')
    const branch = requiredName(input.branch, 'branch')
    const base = requiredName(input.base, 'base branch')
    await this.#invoke(
      'create',
      ['new', '--base', base, '--', branch],
      repositoryPath,
      undefined,
      {},
      () => this.#assertSafeConfiguration(repositoryPath),
      input.signal,
    )
    const listed = await this.list(repositoryPath, { signal: input.signal })
    const created = Array.isArray(listed?.worktrees)
      ? listed.worktrees.find((worktree) => worktree?.branch === branch)
      : null
    if (!created || typeof created.path !== 'string') {
      throw new AgentWorktreeCommandError('create', `agent-worktree created ${branch} but did not report its path.`)
    }
    return created
  }

  async status(worktreePath, options = {}) {
    const result = await this.#invoke(
      'status',
      ['status', '--json'],
      requiredPath(worktreePath, 'worktree path'),
      undefined,
      {},
      undefined,
      options.signal,
    )
    return this.#parseJson('status', result.stdout)
  }

  async sync(input = {}) {
    const worktreePath = requiredPath(input.worktreePath, 'worktree path')
    const from = requiredName(input.from, 'source branch')
    const selectedStrategy = strategy(input.strategy ?? 'merge')
    return this.#invoke(
      'sync',
      ['sync', '--strategy', selectedStrategy, '--from', from],
      worktreePath,
      input.identity,
      {},
      () => this.#assertSafeConfiguration(worktreePath),
      input.signal,
    )
  }

  async continueSync(input = {}) {
    const worktreePath = requiredPath(input.worktreePath, 'worktree path')
    return this.#invoke(
      'continueSync',
      ['sync', '--continue'],
      worktreePath,
      input.identity,
      {},
      () => this.#assertSafeConfiguration(worktreePath),
      input.signal,
    )
  }

  async abortSync(input = {}) {
    const worktreePath = requiredPath(input.worktreePath, 'worktree path')
    return this.#invoke(
      'abortSync',
      ['sync', '--abort'],
      worktreePath,
      undefined,
      {},
      () => this.#assertSafeConfiguration(worktreePath),
      input.signal,
    )
  }

  async merge(input = {}) {
    const repositoryPath = requiredPath(input.repositoryPath, 'repository path')
    const worktreePath = requiredPath(input.worktreePath, 'worktree path')
    const into = requiredName(input.into, 'target branch')
    const selectedStrategy = strategy(input.strategy ?? 'merge')
    const args = ['merge', '--strategy', selectedStrategy, '--into', into]
    if (input.skipHooks !== false) args.push('--skip-hooks')
    return this.withPublicationGuard({
      storagePath: this.storagePath,
      into,
      expectedHead: requiredCommit(input.expectedHead, 'expected target head'),
      commitMessage: optionalCommitMessage(input.commitMessage),
    }, (environment) => this.#invoke(
      'merge',
      args,
      worktreePath,
      input.identity,
      environment,
      async () => {
        await this.#assertSafeConfiguration(repositoryPath)
        if (worktreePath !== repositoryPath) await this.#assertSafeConfiguration(worktreePath)
      },
      input.signal,
    ))
  }

  async remove(input = {}) {
    const repositoryPath = requiredPath(input.repositoryPath, 'repository path')
    const branch = requiredName(input.branch, 'branch')
    const args = ['rm']
    if (input.force) args.push('--force')
    args.push('--', branch)
    return this.#invoke(
      'remove',
      args,
      repositoryPath,
      undefined,
      {},
      () => this.#assertSafeConfiguration(repositoryPath),
      input.signal,
    )
  }

  async gitEnvironment(identity) {
    return this.#safeEnvironment(identity)
  }

  async #invoke(operation, args, cwd, identity, environment = {}, beforeSpawn, signal) {
    const invoke = async () => {
      await this.#ensureSafeRuntime()
      try {
        await beforeSpawn?.()
        const result = await this.run(this.executable, args, {
          cwd,
          encoding: 'utf8',
          env: { ...this.#safeEnvironment(identity), ...environment },
          maxBuffer: MAX_OUTPUT_BYTES,
          shell: false,
          timeout: this.timeoutMs,
          signal,
          windowsHide: true,
        })
        return {
          disposition: 'applied',
          exitCode: 0,
          stdout: boundedText(result?.stdout, MAX_OUTPUT_BYTES),
          stderr: boundedText(result?.stderr, MAX_OUTPUT_BYTES),
        }
      } catch (cause) {
        if (cause instanceof AgentWorktreeCommandError && cause.operation === 'configuration') throw cause
        const exitCode = Number.isInteger(cause?.code) ? cause.code : null
        const detail = boundedText(cause?.stderr || cause?.message || 'unknown failure')
        throw new AgentWorktreeCommandError(
          operation,
          `agent-worktree ${operation} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${detail}`,
          { cause, exitCode, stdout: cause?.stdout, stderr: cause?.stderr },
        )
      }
    }
    const result = this.invokeChain.then(invoke, invoke)
    this.invokeChain = result.catch(() => {})
    return result
  }


  #safeEnvironment(identity) {
    return {
      ...withoutCommandConfig(this.environment),
      ...identityEnvironment(identity),
      AGENT_WORKTREE_DIR: this.storagePath,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: DISABLED_GIT_HOOKS_PATH,
      GIT_CONFIG_KEY_1: 'commit.gpgsign',
      GIT_CONFIG_VALUE_1: 'false',
    }
  }

  async #ensureSafeRuntime() {
    await this.prepareRuntime(this.storagePath)
  }

  async #assertSafeConfiguration(repositoryPath) {
    const projectConfigPath = join(repositoryPath, PROJECT_CONFIG_NAME)
    try {
      await this.projectConfigAccess(projectConfigPath, constants.F_OK)
    } catch (cause) {
      if (cause?.code === 'ENOENT') return
      throw new AgentWorktreeCommandError(
        'configuration',
        `Ensync could not verify that agent-worktree project config is disabled at ${projectConfigPath}.`,
        { cause },
      )
    }
    throw new AgentWorktreeCommandError(
      'configuration',
      `agent-worktree project config is disabled in Ensync because version 0.13.6 can run its hooks without a sandbox or timeout. Move ${PROJECT_CONFIG_NAME} out of the repository before starting an Ensync chat.`,
    )
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

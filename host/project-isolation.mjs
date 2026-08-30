import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  ensureGitRepositoryBaseline,
  gitFailureMessage,
  runGit,
  validateRepositoryLocation,
} from './git.mjs'
import { processIsLiveSince } from './process-liveness.mjs'

const DEFAULT_LOCK_POLL_MS = 250
const DEFAULT_LOCK_STALE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 5_000
const DEFAULT_BASE_FETCH_TTL_MS = 60_000
const DEFAULT_FETCH_TIMEOUT_MS = 120_000
// A first commit walks the whole project, which can outlast an ordinary
// plumbing call on a large folder.
const BASELINE_TIMEOUT_MS = 120_000
const PREFERRED_CANONICAL_REMOTE = 'origin'
const CANONICAL_BRANCH_FALLBACKS = ['main', 'master']
const MAX_WORKSPACE_KEY_CHARACTERS = 512
const MAX_BASELINE_CONFLICT_FILES = 50
const MAX_BASELINE_CONFLICT_PATH_CHARACTERS = 1_024
const WORKSPACE_KEY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const OCCUPIED_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const OCCUPIED_NATIVE_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BYTE_PRESERVING_GIT_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false']

const AGENT_COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Ensync Agent',
  GIT_AUTHOR_EMAIL: 'agent@ensync.local',
  GIT_COMMITTER_NAME: 'Ensync Agent',
  GIT_COMMITTER_EMAIL: 'agent@ensync.local',
}

function agentCommitMessage(details, branch) {
  const lines = [`Ensync agent work (${details.outcome})`, '']
  if (details.provider) lines.push(`Provider: ${details.provider}`)
  if (details.jobId) lines.push(`Job: ${details.jobId}`)
  lines.push(`Workspace-Branch: ${branch}`)
  return lines.join('\n')
}

function baseRefreshIdentity(nowMs) {
  const stamp = new Date(nowMs).toISOString()
  return {
    GIT_AUTHOR_NAME: 'Ensync Workspace Base Refresh',
    GIT_AUTHOR_EMAIL: 'workspace-base@ensync.local',
    GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_NAME: 'Ensync Workspace Base Refresh',
    GIT_COMMITTER_EMAIL: 'workspace-base@ensync.local',
    GIT_COMMITTER_DATE: stamp,
  }
}

function digest(value, length = 24) {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

function pathIsWithin(root, candidate) {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

function boundedConflictFiles(value) {
  return [...new Set(String(value ?? '').split('\0').filter((file) => (
    file.length > 0
    && file.length <= MAX_BASELINE_CONFLICT_PATH_CHARACTERS
    && !WORKSPACE_KEY_CONTROL_CHARACTERS.test(file)
  )))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .slice(0, MAX_BASELINE_CONFLICT_FILES)
}

function cancellationError() {
  return new ProjectIsolationError(
    'run_cancelled',
    'Run stopped before Ensync Host acquired the protected workspace write lease.',
    499,
  )
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError()
}

function waitFor(milliseconds, signal) {
  throwIfCancelled(signal)
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(done, milliseconds)

    function done() {
      signal?.removeEventListener('abort', cancelled)
      resolvePromise()
    }

    function cancelled() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
      rejectPromise(cancellationError())
    }

    signal?.addEventListener('abort', cancelled, { once: true })
  })
}

// Every lease token this OS process currently holds. A lock file records the
// shared Host daemon's pid, never the run's, so the pid alone cannot tell a
// lease this Host is using from one it leaked: both stay "alive" until the
// daemon dies. The token can, and it is the only thing that can.
const heldLeaseTokens = new Set()

function workspaceKey(value) {
  if (value === undefined || value === null) {
    throw new ProjectIsolationError(
      'client_upgrade_required',
      'This Ensync window is older than the running Host. Quit Ensync completely and reopen it before starting another local agent run.',
      409,
    )
  }
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > MAX_WORKSPACE_KEY_CHARACTERS
    || WORKSPACE_KEY_CONTROL_CHARACTERS.test(value)
  ) {
    throw new ProjectIsolationError(
      'invalid_workspace_key',
      'A stable Ensync conversation workspace key is required for local agent execution.',
      400,
    )
  }
  return value
}

function boundedOwner(value) {
  const owner = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const startedAt = typeof owner.startedAt === 'string' && Number.isFinite(Date.parse(owner.startedAt))
    ? owner.startedAt
    : null
  return {
    jobId: typeof owner.jobId === 'string' && OCCUPIED_JOB_ID_PATTERN.test(owner.jobId) ? owner.jobId : null,
    provider: typeof owner.provider === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(owner.provider)
      ? owner.provider
      : null,
    targetKind: owner.targetKind === 'local' || owner.targetKind === 'ssh' ? owner.targetKind : null,
    startedAt,
    providerProcessStarted: owner.providerProcessStarted === true,
    steerable: owner.steerable === true,
    nativeWorkspaceId: typeof owner.nativeWorkspaceId === 'string'
      && OCCUPIED_NATIVE_WORKSPACE_ID_PATTERN.test(owner.nativeWorkspaceId)
      ? owner.nativeWorkspaceId
      : null,
  }
}

async function canonicalDirectory(value, code, message) {
  try {
    const canonical = await realpath(value)
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error('not a directory')
    return canonical
  } catch {
    throw new ProjectIsolationError(code, message, 409)
  }
}

function parseWorktrees(value) {
  const worktrees = []
  let current = null
  for (const line of String(value).split(/\r?\n/)) {
    if (!line) {
      if (current) worktrees.push(current)
      current = null
      continue
    }
    const separator = line.indexOf(' ')
    const field = separator === -1 ? line : line.slice(0, separator)
    const fieldValue = separator === -1 ? true : line.slice(separator + 1)
    if (field === 'worktree') {
      if (current) worktrees.push(current)
      current = { path: fieldValue, branch: null, prunable: false }
    } else if (current && field === 'branch') {
      current.branch = fieldValue
    } else if (current && field === 'prunable') {
      current.prunable = true
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

export class ProjectIsolationError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.name = 'ProjectIsolationError'
    this.code = code
    this.status = status
    this.safeToRetry = false
  }
}

/**
 * Creates stable per-conversation Git worktrees and holds one renewable,
 * cross-process write lease for that conversation workspace while a provider
 * is active. Locks live in the shared Git directory and are keyed by workspace,
 * so duplicate runs against one worktree serialize while separate conversation
 * worktrees in the same repository remain concurrent.
 */
export class ProjectIsolationService {
  #rootPath
  #gitExecutable
  #gitRunner
  #autoInitializeGit
  #homePath
  #lockPollMs
  #lockStaleMs
  #heartbeatMs
  #baseRefresh
  #baseFetchTtlMs
  #fetchTimeoutMs
  #now
  #uuid

  constructor(options = {}) {
    const rootPath = options.rootPath ?? join(homedir(), '.ensync', 'agent-workspaces-v1')
    if (typeof rootPath !== 'string' || !isAbsolute(rootPath)) {
      throw new TypeError('The Ensync agent-workspace root must be an absolute path.')
    }
    this.#rootPath = resolve(rootPath)
    this.#gitExecutable = options.gitExecutable ?? 'git'
    this.#gitRunner = options.gitRunner ?? runGit
    this.#autoInitializeGit = options.autoInitializeGit !== false
    this.#homePath = options.homePath
    this.#lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS
    this.#lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.#baseRefresh = options.baseRefresh !== false
    this.#baseFetchTtlMs = options.baseFetchTtlMs ?? DEFAULT_BASE_FETCH_TTL_MS
    this.#fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    this.#now = options.now ?? Date.now
    this.#uuid = options.randomUUID ?? randomUUID
  }

  async acquire(projectPath, rawWorkspaceKey, options = {}) {
    const key = workspaceKey(rawWorkspaceKey)
    throwIfCancelled(options.signal)
    const canonicalProjectPath = await canonicalDirectory(
      projectPath,
      'invalid_project',
      'The selected project folder does not exist or cannot be accessed.',
    )
    const repository = await this.#repository(canonicalProjectPath)
    const lease = await this.#acquireWorkspaceLease(repository.commonGitDirectory, key, options)

    try {
      throwIfCancelled(options.signal)
      const base = await this.#canonicalBase(repository, options)
      throwIfCancelled(options.signal)
      const workspace = await this.#ensureWorkspace(repository, canonicalProjectPath, key, base)
      lease.assertHeld()
      return {
        ...lease,
        workspace,
      }
    } catch (error) {
      await lease.release()
      throw error
    }
  }

  async tryAcquireOrDescribe(projectPath, rawWorkspaceKey, options = {}) {
    const key = workspaceKey(rawWorkspaceKey)
    throwIfCancelled(options.signal)
    const canonicalProjectPath = await canonicalDirectory(
      projectPath,
      'invalid_project',
      'The selected project folder does not exist or cannot be accessed.',
    )
    const repository = await this.#repository(canonicalProjectPath)
    const admission = await this.#tryAcquireWorkspaceLease(repository.commonGitDirectory, key, options)
    if (admission.disposition === 'occupied') return admission

    try {
      throwIfCancelled(options.signal)
      const base = await this.#canonicalBase(repository, options)
      throwIfCancelled(options.signal)
      const workspace = await this.#ensureWorkspace(repository, canonicalProjectPath, key, base)
      admission.lease.assertHeld()
      return { disposition: 'acquired', lease: { ...admission.lease, workspace } }
    } catch (error) {
      await admission.lease.release()
      throw error
    }
  }

  async commitAgentWork(workspace, details = {}) {
    const outcome = details.outcome ?? 'failed'
    return this.#commitWorktree(workspace.repositoryPath, workspace.branch, { ...details, outcome })
  }

  async checkSharedCheckout(workspace) {
    const before = workspace?.shared
    if (!before) return { available: false }
    try {
      const headResult = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: before.repositoryPath })
      const statusResult = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: before.repositoryPath,
      })
      const afterHead = firstLine(headResult.stdout)
      const afterEntries = statusResult.stdout.split('\0').filter(Boolean)
      const headMoved = afterHead !== before.head
      const statusMoved = afterEntries.join('\n') !== before.statusEntries.join('\n')
      let landed = false
      if (headMoved) {
        const log = await this.#git(['log', '--format=%s', `${before.head}..${afterHead}`], {
          cwd: before.repositoryPath,
          allowFailure: true,
        })
        const subjects = log.exitCode === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : []
        landed = subjects.length > 0 && subjects.every((subject) => subject.startsWith('Ensync land: '))
      }
      // git checkout . shape: same head, a previously-dirty path is no longer dirty.
      const afterPaths = new Set(afterEntries.map((entry) => entry.slice(3)))
      const destructive = !headMoved
        && before.statusEntries.some((entry) => !afterPaths.has(entry.slice(3)))
      const changed = landed ? statusMoved : (headMoved || statusMoved)
      return {
        available: true,
        changed,
        destructive: changed && destructive,
        landed,
        before: { head: before.head, changedFiles: before.statusEntries.length },
        after: { head: afterHead, changedFiles: afterEntries.length },
        checkedAt: new Date(this.#now()).toISOString(),
      }
    } catch {
      return { available: false }
    }
  }

  async recoverStrandedWorktrees() {
    const summary = { scanned: 0, recovered: [], skipped: [] }
    let repositoryHashes
    try {
      repositoryHashes = await readdir(this.#rootPath)
    } catch {
      return summary
    }
    for (const repositoryHash of repositoryHashes) {
      let workspaceHashes
      try {
        workspaceHashes = await readdir(join(this.#rootPath, repositoryHash))
      } catch {
        continue
      }
      for (const workspaceHash of workspaceHashes) {
        let worktreePath = join(this.#rootPath, repositoryHash, workspaceHash)
        summary.scanned += 1
        try {
          worktreePath = await realpath(worktreePath)
          const branchResult = await this.#git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
            cwd: worktreePath,
            allowFailure: true,
          })
          const branch = firstLine(branchResult.stdout)
          if (branchResult.exitCode !== 0 || !branch.startsWith('ensync/chat-')) {
            summary.skipped.push({ worktreePath, reason: 'not_an_agent_worktree' })
            continue
          }
          const commonResult = await this.#git(['rev-parse', '--git-common-dir'], { cwd: worktreePath })
          const commonValue = firstLine(commonResult.stdout)
          const commonDirectory = isAbsolute(commonValue) ? commonValue : resolve(worktreePath, commonValue)
          const lockPath = join(commonDirectory, 'ensync', 'workspace-write-locks', `${workspaceHash}.lock`)
          let leaseHeld = false
          try {
            await stat(lockPath)
            leaseHeld = true
          } catch { /* no active lease */ }
          if (leaseHeld) {
            summary.skipped.push({ worktreePath, reason: 'active_lease' })
            continue
          }
          const result = await this.#commitWorktree(worktreePath, branch, { outcome: 'recovered' })
          if (result.committed) {
            summary.recovered.push({ worktreePath, branch, changedFiles: result.changedFiles, head: result.head })
          } else {
            summary.skipped.push({ worktreePath, reason: 'clean' })
          }
        } catch (error) {
          summary.skipped.push({ worktreePath, reason: error instanceof Error ? error.message : 'unknown_error' })
        }
      }
    }
    return summary
  }

  async #commitWorktree(worktreePath, branch, details) {
    const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: worktreePath,
      code: 'agent_work_commit_failed',
      message: `Ensync could not inspect the protected worktree for ${branch}.`,
    })
    const changedFiles = status.stdout.split('\0').filter(Boolean).length
    if (changedFiles === 0) {
      const head = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath })
      return { committed: false, changedFiles: 0, head: firstLine(head.stdout) }
    }
    const env = {
      ...AGENT_COMMIT_IDENTITY,
      GIT_AUTHOR_DATE: new Date(this.#now()).toISOString(),
      GIT_COMMITTER_DATE: new Date(this.#now()).toISOString(),
    }
    await this.#git(['add', '-A', '--', '.'], {
      cwd: worktreePath,
      env,
      code: 'agent_work_commit_failed',
      message: `Ensync could not stage this run's changes on ${branch}.`,
    })
    await this.#git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', agentCommitMessage(details, branch)], {
      cwd: worktreePath,
      env,
      code: 'agent_work_commit_failed',
      message: `Ensync could not commit this run's changes on ${branch}.`,
    })
    const head = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath })
    return { committed: true, changedFiles, head: firstLine(head.stdout) }
  }

  async #git(args, options = {}) {
    let result
    try {
      result = await this.#gitRunner(args, {
        cwd: options.cwd,
        env: options.env,
        gitExecutable: this.#gitExecutable,
        timeoutMs: options.timeoutMs,
      })
    } catch (error) {
      throw new ProjectIsolationError(
        error?.code === 'git_unavailable' ? 'git_unavailable' : 'project_isolation_failed',
        error instanceof Error ? error.message : 'Ensync Host could not run Git for project isolation.',
        Number.isInteger(error?.status) ? error.status : 503,
      )
    }
    if (result.exitCode !== 0 && !options.allowFailure) {
      throw new ProjectIsolationError(
        options.code ?? 'project_isolation_failed',
        gitFailureMessage(
          result.stderr,
          options.message ?? 'Git could not prepare an isolated Ensync workspace.',
          options.includeGitReason !== false,
        ),
        options.status ?? 409,
      )
    }
    return result
  }

  /**
   * Isolation needs a repository with a commit to branch from. Rather than
   * refusing a project folder that has neither, Ensync creates them, which is
   * also the change that keeps the person's files under version control while
   * an agent works. A folder already inside a repository is never re-created.
   */
  async #ensureRepositoryBaseline(projectPath) {
    if (!this.#autoInitializeGit) return
    const outcome = await ensureGitRepositoryBaseline(
      projectPath,
      (args, options) => this.#git(args, { ...options, timeoutMs: options.timeoutMs ?? BASELINE_TIMEOUT_MS }),
      { homePath: this.#homePath },
    )
    if (outcome.refused === 'home_directory') {
      throw new ProjectIsolationError(
        'project_isolation_required',
        'A home directory is too broad to become one Ensync project repository. Open the specific project folder the agent should work in.',
      )
    }
  }

  async #repository(projectPath) {
    await this.#ensureRepositoryBaseline(projectPath)
    const topLevel = await this.#git(['rev-parse', '--show-toplevel'], {
      cwd: projectPath,
      code: 'project_isolation_required',
      message: 'Local agent execution requires a Git repository so Ensync can isolate changes from the shared checkout. Open a project folder that Ensync is allowed to initialize, or create the repository yourself.',
      includeGitReason: false,
    })
    const repositoryPath = await canonicalDirectory(
      firstLine(topLevel.stdout),
      'project_isolation_required',
      'Ensync Host could not verify the selected project as a Git working tree.',
    )
    if (!pathIsWithin(repositoryPath, projectPath)) {
      throw new ProjectIsolationError(
        'project_isolation_required',
        'The selected project is not contained by its verified Git working tree.',
      )
    }

    const commonDirectory = await this.#git(['rev-parse', '--git-common-dir'], { cwd: projectPath })
    const commonValue = firstLine(commonDirectory.stdout)
    const commonCandidate = isAbsolute(commonValue) ? commonValue : resolve(repositoryPath, commonValue)
    const commonGitDirectory = await canonicalDirectory(
      commonCandidate,
      'project_isolation_required',
      'Ensync Host could not verify the repository shared Git directory.',
    )

    const head = await this.#git(['rev-parse', '--verify', 'HEAD'], {
      cwd: repositoryPath,
      code: 'project_baseline_unavailable',
      message: 'Create an initial Git commit before starting an isolated Ensync agent workspace.',
    })
    return {
      projectPath,
      repositoryPath,
      commonGitDirectory,
      head: firstLine(head.stdout),
    }
  }

  async #acquireWorkspaceLease(commonGitDirectory, key, options) {
    return this.#acquireLease(join(commonGitDirectory, 'ensync', 'workspace-write-locks'), digest(key), options)
  }

  async #tryAcquireWorkspaceLease(commonGitDirectory, key, options) {
    return this.#acquireLease(join(commonGitDirectory, 'ensync', 'workspace-write-locks'), digest(key), {
      ...options,
      nonBlocking: true,
    })
  }

  async #acquireLease(lockParent, workspaceHash, options) {
    const lockPath = join(lockParent, `${workspaceHash}.lock`)
    const ownerPath = join(lockPath, 'owner.json')
    await mkdir(lockParent, { recursive: true, mode: 0o700 })
    let waitingReported = false

    for (;;) {
      throwIfCancelled(options.signal)
      const token = this.#uuid()
      const acquiredAt = new Date(this.#now()).toISOString()
      try {
        await mkdir(lockPath, { mode: 0o700 })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        if (options.nonBlocking) {
          if (await this.#quarantineStaleLock(lockPath, ownerPath)) continue
          return { disposition: 'occupied', owner: await this.#occupiedOwner(ownerPath) }
        }
        if (!waitingReported) {
          waitingReported = true
          options.onWait?.()
        }
        if (await this.#quarantineStaleLock(lockPath, ownerPath)) continue
        await waitFor(this.#lockPollMs, options.signal)
        continue
      }

      try {
        const controller = new AbortController()
        let released = false
        let failure = null
        let ownerMetadata = boundedOwner(options.owner)
        const owner = () => ({
          version: 2,
          token,
          pid: process.pid,
          workspaceHash,
          acquiredAt,
          heartbeatAt: new Date(this.#now()).toISOString(),
          owner: ownerMetadata,
        })
        // Replace the record atomically so no reader — this heartbeat, release,
        // or another Host's staleness probe — can observe a file between
        // truncate and write.
        const writeOwner = async () => {
          const pendingPath = `${ownerPath}.${this.#uuid()}.tmp`
          await writeFile(pendingPath, JSON.stringify(owner()), { encoding: 'utf8', mode: 0o600 })
          try { await chmod(pendingPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
          await rename(pendingPath, ownerPath)
        }
        await writeOwner()

        heldLeaseTokens.add(token)

        // Ticks are serialized: a write delayed by fs load must not race the
        // next tick's read into a false lease loss. The in-flight tick is also
        // what release waits on, so a write can never outlive its own lease.
        let pendingTick = null
        const refreshOwner = () => {
          if (pendingTick || released) return pendingTick ?? Promise.resolve()
          pendingTick = (async () => {
            try {
              const current = JSON.parse(await readFile(ownerPath, 'utf8'))
              if (released) return
              if (current?.token !== token) throw new Error('Protected workspace write lease ownership changed unexpectedly.')
              await writeOwner()
            } catch (error) {
              if (released) return
              failure = new ProjectIsolationError(
                'workspace_write_lock_lost',
                error instanceof Error
                  ? `Ensync Host lost the protected workspace write lease: ${error.message}`
                  : 'Ensync Host lost the protected workspace write lease.',
                409,
              )
              controller.abort(failure)
              clearInterval(heartbeat)
              heldLeaseTokens.delete(token)
            }
          })().finally(() => { pendingTick = null })
          return pendingTick
        }
        const heartbeat = setInterval(() => {
          void refreshOwner()
        }, this.#heartbeatMs)
        heartbeat.unref?.()

        // Removal is verified rather than assumed. A lock this Host stopped
        // heartbeating but left standing blocks every later run in the same
        // conversation, so a failure to delete it is reported, never swallowed.
        const removeOwnedLock = async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            let current = null
            try {
              current = JSON.parse(await readFile(ownerPath, 'utf8'))
            } catch (error) {
              if (error?.code !== 'ENOENT') {
                return {
                  removed: false,
                  reason: `Ensync could not read this workspace lease record to release it: ${error instanceof Error ? error.message : 'unknown error'}`,
                }
              }
            }
            // A missing or replaced record belongs to whoever holds the lock
            // now, and is never authority to delete another owner's lease.
            if (!current || current.token !== token) return { removed: true, reason: null }
            try {
              await rm(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
            } catch (error) {
              return {
                removed: false,
                reason: `Ensync could not remove this conversation's workspace lease at ${lockPath}: ${error instanceof Error ? error.message : 'unknown error'}`,
              }
            }
            try {
              await stat(lockPath)
            } catch {
              return { removed: true, reason: null }
            }
          }
          return {
            removed: false,
            reason: `This conversation's workspace lease at ${lockPath} reappeared while Ensync was releasing it.`,
          }
        }

        let releaseOutcome = null
        const lease = {
          signal: controller.signal,
          assertHeld() {
            if (failure) throw failure
          },
          updateOwner(patch) {
            ownerMetadata = boundedOwner({ ...ownerMetadata, ...patch })
            return refreshOwner()
          },
          release: async () => {
            if (released) return releaseOutcome ?? { removed: true, reason: null }
            released = true
            clearInterval(heartbeat)
            heldLeaseTokens.delete(token)
            // A tick that already began its atomic replace has to finish first.
            // Deleting the directory underneath it leaves the pending rename to
            // recreate a lock nobody owns any more — with this Host's own pid
            // inside it, which is exactly how a released lease becomes immortal.
            try {
              await pendingTick
            } catch {
              // A tick that failed has already reported the lost lease.
            }
            releaseOutcome = await removeOwnedLock()
            return releaseOutcome
          },
        }
        return options.nonBlocking ? { disposition: 'acquired', lease } : lease
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }
  }

  async #quarantineStaleLock(lockPath, ownerPath) {
    let freshest
    let ownerPid = null
    let ownerToken = null
    try {
      const [ownerInfo, lockInfo] = await Promise.all([stat(ownerPath), stat(lockPath)])
      freshest = Math.max(ownerInfo.mtimeMs, lockInfo.mtimeMs)
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
        if (Number.isInteger(owner?.pid) && owner.pid > 0) ownerPid = owner.pid
        if (typeof owner?.token === 'string' && owner.token) ownerToken = owner.token
        const heartbeat = Date.parse(owner?.heartbeatAt ?? '')
        if (Number.isFinite(heartbeat)) freshest = Math.max(freshest, heartbeat)
      } catch {
        // File mtimes remain the conservative fallback for incomplete metadata.
      }
    } catch {
      try {
        freshest = (await stat(lockPath)).mtimeMs
      } catch {
        return true
      }
    }
    if (this.#now() - freshest <= this.#lockStaleMs) return false
    // A lock this same process left behind is a leak, not work in progress:
    // its token is gone from the live set the moment the lease ends. Without
    // this, every lease the long-lived Host daemon leaks is guarded by that
    // daemon's own pid until it dies, and its conversation never runs again.
    const leakedByThisHost = ownerPid === process.pid && !heldLeaseTokens.has(ownerToken)
    // A live Host may be temporarily suspended while its provider child is
    // still mutating. Never steal that lease merely because timers paused.
    // The PID is only that Host's name while it still holds it: a lock left by
    // a Host that died in a reboot names a PID the system has since reissued,
    // and trusting it alone strands the conversation behind it forever.
    if (!leakedByThisHost && processIsLiveSince(ownerPid, freshest, { now: this.#now() })) return false

    const quarantinePath = `${lockPath}.stale-${this.#uuid()}`
    try {
      await rename(lockPath, quarantinePath)
      await rm(quarantinePath, { recursive: true, force: true })
      return true
    } catch (error) {
      return error?.code === 'ENOENT'
    }
  }

  async #occupiedOwner(ownerPath) {
    try {
      const record = JSON.parse(await readFile(ownerPath, 'utf8'))
      return boundedOwner(record?.owner)
    } catch {
      return boundedOwner(null)
    }
  }

  async #canonicalRemote(repository) {
    const remotes = await this.#git(['remote'], { cwd: repository.repositoryPath, allowFailure: true })
    if (remotes.exitCode !== 0) return null
    const names = String(remotes.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (names.includes(PREFERRED_CANONICAL_REMOTE)) return PREFERRED_CANONICAL_REMOTE
    return names.length === 1 ? names[0] : null
  }

  async #canonicalBranch(repository, remote) {
    const symbolic = await this.#git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], {
      cwd: repository.repositoryPath,
      allowFailure: true,
    })
    if (symbolic.exitCode === 0) {
      const value = firstLine(symbolic.stdout)
      const prefix = `${remote}/`
      if (value.startsWith(prefix) && value.length > prefix.length) return value.slice(prefix.length)
    }
    for (const candidate of CANONICAL_BRANCH_FALLBACKS) {
      const found = await this.#git(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${candidate}`], {
        cwd: repository.repositoryPath,
        allowFailure: true,
      })
      if (found.exitCode === 0) return candidate
    }
    return null
  }

  async #isAncestor(cwd, ancestor, descendant) {
    const result = await this.#git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd, allowFailure: true })
    return result.exitCode === 0
  }

  async #canonicalFetchIsFresh(markerPath, remote) {
    if (this.#baseFetchTtlMs <= 0) return false
    try {
      const marker = JSON.parse(await readFile(markerPath, 'utf8'))
      if (marker?.remote !== remote) return false
      const fetchedAt = Date.parse(marker?.fetchedAt ?? '')
      if (!Number.isFinite(fetchedAt)) return false
      const age = this.#now() - fetchedAt
      return age >= 0 && age <= this.#baseFetchTtlMs
    } catch {
      return false
    }
  }

  /**
   * Updates this repository's remote-tracking refs under one repository-scoped
   * lock so simultaneous conversations in the same checkout share a single real
   * fetch. A fetch failure is reported, never fatal: an offline computer still
   * starts its workspace from the last fetched reference.
   */
  async #refreshCanonicalRefs(repository, remote, options) {
    const markerPath = join(repository.commonGitDirectory, 'ensync', 'canonical-base.json')
    if (await this.#canonicalFetchIsFresh(markerPath, remote)) return { fetched: false, reason: null }

    const lease = await this.#acquireLease(
      join(repository.commonGitDirectory, 'ensync', 'canonical-fetch-locks'),
      digest(`${repository.commonGitDirectory} ${remote}`),
      { signal: options.signal },
    )
    try {
      if (await this.#canonicalFetchIsFresh(markerPath, remote)) return { fetched: false, reason: null }
      let result
      try {
        result = await this.#git(['fetch', '--no-tags', '--quiet', remote], {
          cwd: repository.repositoryPath,
          allowFailure: true,
          timeoutMs: this.#fetchTimeoutMs,
        })
      } catch (error) {
        return { fetched: false, reason: error instanceof Error ? error.message : 'Git could not fetch the canonical remote.' }
      }
      if (result.exitCode !== 0) {
        return { fetched: false, reason: firstLine(result.stderr) || 'Git could not fetch the canonical remote.' }
      }
      await writeFile(
        markerPath,
        JSON.stringify({ version: 1, remote, fetchedAt: new Date(this.#now()).toISOString() }),
        { encoding: 'utf8', mode: 0o600 },
      )
      return { fetched: true, reason: null }
    } finally {
      await lease.release()
    }
  }

  /**
   * Resolves the commit a protected workspace should be built on. Ensync only
   * advances past the shared checkout's own commit when that commit is already
   * contained by the fetched canonical branch, so a feature checkout, a local
   * checkout that is ahead, and divergent history all keep their own base and
   * report exactly why instead of being silently rewritten.
   */
  async #canonicalBase(repository, options) {
    const base = {
      sha: repository.head,
      canonicalSha: null,
      source: 'local_head',
      reason: null,
      remote: null,
      branch: null,
    }
    if (!this.#baseRefresh) {
      base.reason = 'Canonical base refresh is disabled for this Ensync Host.'
      return base
    }

    const remote = await this.#canonicalRemote(repository)
    if (!remote) {
      base.reason = 'This repository has no single configured canonical Git remote, so the shared checkout commit stays the base.'
      return base
    }
    base.remote = remote

    try {
      const configured = await this.#git(['remote', 'get-url', '--all', remote], {
        cwd: repository.repositoryPath,
        allowFailure: true,
      })
      const urls = String(configured.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      if (configured.exitCode !== 0 || urls.length === 0) throw new Error('no configured URL')
      for (const url of urls) validateRepositoryLocation(url)
    } catch {
      base.source = 'unsafe_remote'
      base.reason = `Git remote ${remote} has a missing or unsupported URL, so Ensync never fetched it. External remote helpers and relative paths stay blocked.`
      return base
    }

    const fetched = await this.#refreshCanonicalRefs(repository, remote, options)
    const branch = await this.#canonicalBranch(repository, remote)
    if (!branch) {
      base.source = 'stale_remote_ref'
      base.reason = fetched.reason
        ? `Ensync could not fetch ${remote} (${fetched.reason}) and has no fetched default branch for it.`
        : `Ensync could not discover a default branch on ${remote}.`
      return base
    }
    base.branch = branch

    const canonical = await this.#git(['rev-parse', '--verify', `refs/remotes/${remote}/${branch}`], {
      cwd: repository.repositoryPath,
      allowFailure: true,
    })
    if (canonical.exitCode !== 0) {
      base.source = 'stale_remote_ref'
      base.reason = fetched.reason
        ? `Ensync could not fetch ${remote}: ${fetched.reason}`
        : `Ensync has no fetched ${remote}/${branch} commit for this repository.`
      return base
    }
    base.canonicalSha = firstLine(canonical.stdout)

    if (base.canonicalSha === repository.head) {
      base.source = 'already_canonical'
    } else if (await this.#isAncestor(repository.repositoryPath, repository.head, base.canonicalSha)) {
      base.sha = base.canonicalSha
      base.source = 'remote_default_branch'
    } else if (await this.#isAncestor(repository.repositoryPath, base.canonicalSha, repository.head)) {
      base.source = 'local_head_ahead'
      base.reason = `The shared checkout is ahead of ${remote}/${branch}, so its own commit stays the base.`
    } else {
      base.source = 'divergent_local_history'
      base.reason = `The shared checkout and ${remote}/${branch} have diverged, so Ensync kept the shared checkout commit instead of choosing a base for you. Reconcile them to let new workspaces start from ${remote}/${branch}.`
    }

    if (fetched.reason) {
      base.source = 'stale_remote_ref'
      base.reason = `Ensync could not fetch ${remote}, so this base comes from the last fetched ${remote}/${branch} reference: ${fetched.reason}${base.reason ? ` ${base.reason}` : ''}`
    }
    return base
  }

  /**
   * Brings an already-created conversation worktree onto the current canonical
   * base. This merges rather than rebases so committed agent work is never
   * rewritten, and it refuses instead of forcing whenever Git reports a
   * conflict or an unfinished operation. It runs after the baseline sync with
   * the shared checkout commit. Conflicts are reported as deferred base state;
   * they are reconciled by the landing workflow after the provider turn.
   */
  async #refreshReusedWorkspace(worktreePath, branch, base) {
    if (base.source !== 'remote_default_branch') return { refreshed: false, reason: base.reason }
    if (await this.#isAncestor(worktreePath, base.sha, 'HEAD')) return { refreshed: false, reason: null }

    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'REVERT_HEAD']) {
      const found = await this.#git(['rev-parse', '--verify', '--quiet', marker], { cwd: worktreePath, allowFailure: true })
      if (found.exitCode === 0) {
        return {
          refreshed: false,
          reason: `The protected worktree has an unfinished Git ${marker} operation, so Ensync left ${branch} on its existing base.`,
        }
      }
    }

    const merged = await this.#git(['-c', 'commit.gpgsign=false', 'merge', '--no-edit', '--no-verify', base.sha], {
      cwd: worktreePath,
      allowFailure: true,
      env: baseRefreshIdentity(this.#now()),
    })
    if (merged.exitCode !== 0) {
      await this.#git(['merge', '--abort'], { cwd: worktreePath, allowFailure: true })
      return {
        refreshed: false,
        reason: firstLine(merged.stderr)
          || firstLine(merged.stdout)
          || `Ensync could not bring ${base.remote}/${base.branch} into ${branch}; resolve it in the protected worktree.`,
      }
    }
    return { refreshed: true, reason: null }
  }

  /**
   * Applies the shared checkout's uncommitted work as a patch on top of the
   * canonical base. A tree-level copy would present everything the base already
   * contains as an agent deletion, so the snapshot is replayed against its own
   * parent instead.
   */
  async #replaySharedCheckout(worktreePath, snapshot, baseSha) {
    const applied = await this.#git([...BYTE_PRESERVING_GIT_CONFIG, 'cherry-pick', '--no-commit', snapshot], {
      cwd: worktreePath,
      allowFailure: true,
    })
    if (applied.exitCode !== 0) {
      const reason = firstLine(applied.stderr)
        || firstLine(applied.stdout)
        || 'Git could not replay the shared checkout onto the canonical base.'
      await this.#git(['cherry-pick', '--quit'], { cwd: worktreePath, allowFailure: true })
      return { ok: false, reason }
    }
    await this.#git(['reset', '--mixed', baseSha], {
      cwd: worktreePath,
      code: 'managed_worktree_create_failed',
      message: 'Git could not expose the replayed shared-checkout snapshot as uncommitted work.',
    })
    return { ok: true, reason: null }
  }

  /**
   * Reports whether this conversation's committed work is already contained by
   * the canonical branch. Ensync never merges it automatically, so stranded work
   * stays visible instead of silently disappearing from the next workspace.
   */
  async #integrationState(worktreePath, canonicalSha) {
    if (!canonicalSha) return { canonicalSha: null, integrated: null, unintegratedCommits: null }
    const integrated = await this.#isAncestor(worktreePath, 'HEAD', canonicalSha)
    const counted = await this.#git(['rev-list', '--count', `${canonicalSha}..HEAD`], {
      cwd: worktreePath,
      allowFailure: true,
    })
    const unintegratedCommits = counted.exitCode === 0 ? Number.parseInt(firstLine(counted.stdout), 10) : Number.NaN
    return {
      canonicalSha,
      integrated,
      unintegratedCommits: Number.isInteger(unintegratedCommits) ? unintegratedCommits : null,
    }
  }

  async #ensureWorkspace(repository, canonicalProjectPath, key, base) {
    const workspaceHash = digest(key)
    const repositoryHash = digest(repository.commonGitDirectory)
    const branch = `ensync/chat-${workspaceHash}`
    const branchRef = `refs/heads/${branch}`
    const configuredPath = join(this.#rootPath, repositoryHash, workspaceHash)
    const worktreeList = await this.#git(['worktree', 'list', '--porcelain'], { cwd: repository.repositoryPath })
    const registered = parseWorktrees(worktreeList.stdout).find((worktree) => worktree.branch === branchRef)
    let worktreePath
    let reused = false
    let seededFromSharedCheckout = false
    let branchExistedBeforeAcquire
    let baseRefresh
    let baselineConflict = null

    if (registered) {
      if (registered.prunable) {
        throw new ProjectIsolationError(
          'managed_worktree_missing',
          `The protected Ensync branch ${branch} points to a missing worktree. Restore it or remove the stale Git worktree registration before continuing.`,
        )
      }
      worktreePath = await canonicalDirectory(
        registered.path,
        'managed_worktree_missing',
        `The protected Ensync worktree for ${branch} is missing or inaccessible.`,
      )
      reused = true
      branchExistedBeforeAcquire = true
    } else {
      const branchCheck = await this.#git(['show-ref', '--verify', '--quiet', branchRef], {
        cwd: repository.repositoryPath,
        allowFailure: true,
      })
      const branchExists = branchCheck.exitCode === 0
      branchExistedBeforeAcquire = branchExists
      let snapshot = null
      if (!branchExists) {
        const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
          cwd: repository.repositoryPath,
        })
        const changedFiles = status.stdout.split('\0').filter(Boolean).length
        if (changedFiles > 0) {
          snapshot = await this.#snapshotSharedCheckout(repository)
          seededFromSharedCheckout = true
        }
      }
      // The snapshot commit is only a transport for uncommitted work. When the
      // canonical base is the shared checkout's own commit it can be checked out
      // directly; when the base moved ahead the snapshot must be replayed as a
      // patch so already-integrated work is not presented as an agent deletion.
      const replayOntoBase = Boolean(snapshot) && base.sha !== repository.head
      const startingPoint = snapshot && !replayOntoBase ? snapshot : base.sha
      const createWorktree = async (revision) => {
        await mkdir(resolve(configuredPath, '..'), { recursive: true, mode: 0o700 })
        const worktreeArgs = branchExists
          ? ['worktree', 'add', configuredPath, branch]
          : ['worktree', 'add', '-b', branch, configuredPath, revision]
        await this.#git(
          seededFromSharedCheckout
            ? [...BYTE_PRESERVING_GIT_CONFIG, ...worktreeArgs]
            : worktreeArgs,
          {
            cwd: repository.repositoryPath,
            code: 'managed_worktree_create_failed',
            message: `Git could not create the protected Ensync worktree for ${branch}.`,
          },
        )
        return canonicalDirectory(
          configuredPath,
          'managed_worktree_create_failed',
          `The protected Ensync worktree for ${branch} was not created correctly.`,
        )
      }

      worktreePath = await createWorktree(startingPoint)
      if (!branchExists) baseRefresh = { refreshed: base.source === 'remote_default_branch', reason: base.reason }

      if (replayOntoBase) {
        const replayed = await this.#replaySharedCheckout(worktreePath, snapshot, base.sha)
        if (!replayed.ok) {
          // The shared checkout's uncommitted work conflicts with the canonical
          // base. Keep that work exactly as the user left it on the local commit
          // and report the conflict instead of resolving it for them.
          await this.#git(['worktree', 'remove', '--force', configuredPath], {
            cwd: repository.repositoryPath,
            allowFailure: true,
          })
          await this.#git(['branch', '-D', branch], { cwd: repository.repositoryPath, allowFailure: true })
          worktreePath = await createWorktree(snapshot)
          await this.#git(['reset', '--mixed', repository.head], {
            cwd: worktreePath,
            code: 'managed_worktree_create_failed',
            message: `Git could not expose the shared-checkout snapshot in ${branch}.`,
          })
          base.sha = repository.head
          base.source = 'local_changes_conflict'
          base.reason = `Uncommitted shared-checkout work conflicts with ${base.remote}/${base.branch}, so this workspace kept the local commit as its base: ${replayed.reason}`
          baseRefresh = { refreshed: false, reason: base.reason }
        }
      } else if (seededFromSharedCheckout) {
        // Keep the copied shared-checkout state visible as uncommitted work.
        // The temporary snapshot commit is only a transport mechanism and is
        // removed from the protected branch before provider execution.
        await this.#git(['reset', '--mixed', repository.head], {
          cwd: worktreePath,
          code: 'managed_worktree_create_failed',
          message: `Git could not expose the shared-checkout snapshot in ${branch}.`,
        })
      }
    }

    const createdThisAcquire = !registered && !branchExistedBeforeAcquire
    if (!createdThisAcquire) {
      const leftovers = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath })
      if (leftovers.stdout.split('\0').filter(Boolean).length > 0) {
        await this.#commitWorktree(worktreePath, branch, { outcome: 'recovered' })
      }
    }

    if (!createdThisAcquire) {
      const upToDate = await this.#git(['merge-base', '--is-ancestor', repository.head, 'HEAD'], {
        cwd: worktreePath,
        allowFailure: true,
      })
      if (upToDate.exitCode !== 0) {
        const merge = await this.#git(
          ['-c', 'commit.gpgsign=false', 'merge', '--no-edit', '--no-verify',
            '-m', `Ensync baseline sync into ${branch}`, repository.head],
          {
            cwd: worktreePath,
            env: {
              GIT_AUTHOR_NAME: 'Ensync Agent',
              GIT_AUTHOR_EMAIL: 'agent@ensync.local',
              GIT_COMMITTER_NAME: 'Ensync Agent',
              GIT_COMMITTER_EMAIL: 'agent@ensync.local',
            },
            allowFailure: true,
          },
        )
        if (merge.exitCode !== 0) {
          const conflicted = await this.#git(['diff', '--name-only', '--diff-filter=U', '-z'], {
            cwd: worktreePath,
            allowFailure: true,
          })
          const files = boundedConflictFiles(conflicted.stdout)
          const aborted = await this.#git(['merge', '--abort'], { cwd: worktreePath, allowFailure: true })
          const mergeHead = await this.#git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
            cwd: worktreePath,
            allowFailure: true,
          })
          const unmerged = await this.#git(['diff', '--name-only', '--diff-filter=U', '-z'], {
            cwd: worktreePath,
            allowFailure: true,
          })
          const recoveredStatus = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
            cwd: worktreePath,
            allowFailure: true,
          })
          if (
            aborted.exitCode !== 0
            || mergeHead.exitCode === 0
            || unmerged.exitCode !== 0
            || unmerged.stdout !== ''
            || recoveredStatus.exitCode !== 0
            || recoveredStatus.stdout !== ''
          ) {
            throw new ProjectIsolationError(
              'workspace_baseline_recovery_failed',
              `New baseline changes conflict with this conversation's work, and Ensync could not restore the protected branch ${branch} to a clean state. Inspect ${worktreePath} before continuing.`,
              409,
            )
          }
          const reason = 'New baseline changes conflict with this conversation’s work. Ensync preserved the clean conversation branch and will reconcile it before landing.'
          baselineConflict = {
            baselineSha: repository.head,
            files,
            reason,
          }
          baseRefresh = { refreshed: false, reason }
        }
      }
    }

    if (!createdThisAcquire && !baselineConflict) {
      baseRefresh = await this.#refreshReusedWorkspace(worktreePath, branch, base)
    }

    const isolatedCommon = await this.#git(['rev-parse', '--git-common-dir'], { cwd: worktreePath })
    const isolatedCommonValue = firstLine(isolatedCommon.stdout)
    const isolatedCommonPath = await canonicalDirectory(
      isAbsolute(isolatedCommonValue) ? isolatedCommonValue : resolve(worktreePath, isolatedCommonValue),
      'managed_worktree_mismatch',
      'The protected Ensync worktree no longer belongs to the selected Git repository.',
    )
    if (isolatedCommonPath !== repository.commonGitDirectory) {
      throw new ProjectIsolationError(
        'managed_worktree_mismatch',
        'The protected Ensync worktree belongs to a different Git repository.',
      )
    }

    const actualBranch = await this.#git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: worktreePath,
      code: 'managed_worktree_mismatch',
      message: 'The protected Ensync worktree is detached or on an unexpected branch.',
    })
    if (firstLine(actualBranch.stdout) !== branch) {
      throw new ProjectIsolationError(
        'managed_worktree_mismatch',
        `The protected Ensync worktree must remain on ${branch}.`,
      )
    }

    const projectRelativePath = relative(repository.repositoryPath, canonicalProjectPath)
    const workspaceProjectCandidate = resolve(worktreePath, projectRelativePath)
    if (!pathIsWithin(worktreePath, workspaceProjectCandidate)) {
      throw new ProjectIsolationError('managed_worktree_mismatch', 'The isolated project path escaped its protected worktree.')
    }
    const workspaceProjectPath = await canonicalDirectory(
      workspaceProjectCandidate,
      'managed_project_missing',
      'The selected project directory is missing from its protected Ensync worktree.',
    )
    if (!pathIsWithin(worktreePath, workspaceProjectPath)) {
      throw new ProjectIsolationError(
        'managed_worktree_mismatch',
        'The isolated project path resolves outside its protected Ensync worktree.',
      )
    }

    const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath })
    const changedFiles = status.stdout.split('\0').filter(Boolean).length
    const head = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath })

    const sharedHead = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: repository.repositoryPath })
    const sharedStatus = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repository.repositoryPath,
    })
    const shared = {
      repositoryPath: repository.repositoryPath,
      head: firstLine(sharedHead.stdout),
      statusEntries: sharedStatus.stdout.split('\0').filter(Boolean),
    }

    if (baselineConflict) {
      base.source = 'base_refresh_deferred'
      base.sha = firstLine(head.stdout)
      base.reason = baselineConflict.reason
    } else if (!baseRefresh.refreshed && baseRefresh.reason && base.source === 'remote_default_branch') {
      // Ensync could not bring this existing worktree onto the canonical commit,
      // so it still stands on its own base. Report that rather than the commit
      // Ensync wanted it to have.
      base.source = 'base_refresh_deferred'
      base.sha = firstLine(head.stdout)
      base.reason = baseRefresh.reason
    }

    return {
      canonicalProjectPath,
      commonGitDirectory: repository.commonGitDirectory,
      repositoryPath: worktreePath,
      projectPath: workspaceProjectPath,
      branch,
      reused,
      seededFromSharedCheckout,
      baselineConflict,
      shared,
      base: {
        sha: base.sha,
        canonicalSha: base.canonicalSha,
        source: base.source,
        reason: baseRefresh.reason ?? base.reason,
        remote: base.remote,
        branch: base.branch,
        refreshed: baseRefresh.refreshed,
      },
      integration: await this.#integrationState(
        worktreePath,
        baselineConflict?.baselineSha ?? base.canonicalSha,
      ),
      gitBefore: {
        branch,
        head: firstLine(head.stdout),
        dirty: changedFiles > 0,
        changedFiles,
        checkedAt: new Date(this.#now()).toISOString(),
      },
    }
  }

  async #snapshotSharedCheckout(repository) {
    const snapshotParent = join(repository.commonGitDirectory, 'ensync')
    await mkdir(snapshotParent, { recursive: true, mode: 0o700 })
    const snapshotDirectory = await mkdtemp(join(snapshotParent, 'workspace-snapshot-'))
    const env = {
      GIT_INDEX_FILE: join(snapshotDirectory, 'index'),
      GIT_WORK_TREE: repository.repositoryPath,
      GIT_AUTHOR_NAME: 'Ensync Workspace Snapshot',
      GIT_AUTHOR_EMAIL: 'workspace-snapshot@ensync.local',
      GIT_AUTHOR_DATE: new Date(this.#now()).toISOString(),
      GIT_COMMITTER_NAME: 'Ensync Workspace Snapshot',
      GIT_COMMITTER_EMAIL: 'workspace-snapshot@ensync.local',
      GIT_COMMITTER_DATE: new Date(this.#now()).toISOString(),
    }
    try {
      await this.#git(['read-tree', repository.head], { cwd: repository.repositoryPath, env })
      await this.#git([...BYTE_PRESERVING_GIT_CONFIG, 'add', '-A', '--', '.'], {
        cwd: repository.repositoryPath,
        env,
        code: 'shared_checkout_snapshot_failed',
        message: 'Git could not capture the current shared checkout for the protected workspace.',
      })
      const tree = await this.#git(['write-tree'], { cwd: repository.repositoryPath, env })
      const commit = await this.#git([
        'commit-tree', firstLine(tree.stdout), '-p', repository.head,
        '-m', 'Ensync protected workspace snapshot',
      ], {
        cwd: repository.repositoryPath,
        env,
        code: 'shared_checkout_snapshot_failed',
        message: 'Git could not finalize the protected workspace snapshot.',
      })
      return firstLine(commit.stdout)
    } finally {
      await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => {})
    }
  }
}

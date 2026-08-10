import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { runGit } from './git.mjs'

const DEFAULT_LOCK_POLL_MS = 250
const DEFAULT_LOCK_STALE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 5_000
const MAX_WORKSPACE_KEY_CHARACTERS = 512
const WORKSPACE_KEY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

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

function cancellationError() {
  return new ProjectIsolationError(
    'run_cancelled',
    'Run stopped before Ensync Host acquired the project write lease.',
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

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function workspaceKey(value) {
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
 * cross-process write lease for the repository while a provider is active.
 * The lock lives in the shared Git directory so separate Ensync Host processes
 * and linked worktrees resolve to the same serialization boundary.
 */
export class ProjectIsolationService {
  #rootPath
  #gitExecutable
  #gitRunner
  #lockPollMs
  #lockStaleMs
  #heartbeatMs
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
    this.#lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS
    this.#lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
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
    const lease = await this.#acquireWriteLease(repository.commonGitDirectory, options)

    try {
      throwIfCancelled(options.signal)
      const workspace = await this.#ensureWorkspace(repository, canonicalProjectPath, key)
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
        firstLine(result.stderr) || options.message || 'Git could not prepare an isolated Ensync workspace.',
        options.status ?? 409,
      )
    }
    return result
  }

  async #repository(projectPath) {
    const topLevel = await this.#git(['rev-parse', '--show-toplevel'], {
      cwd: projectPath,
      code: 'project_isolation_required',
      message: 'Local agent execution requires a Git repository so Ensync can isolate changes from the shared checkout.',
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

  async #acquireWriteLease(commonGitDirectory, options) {
    const lockParent = join(commonGitDirectory, 'ensync')
    const lockPath = join(lockParent, 'project-write.lock')
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
        let heartbeatTask = null
        const ownerStagingPath = join(lockPath, `owner-${token}.staging`)
        const owner = () => ({
          version: 1,
          token,
          pid: process.pid,
          acquiredAt,
          heartbeatAt: new Date(this.#now()).toISOString(),
        })
        const writeOwner = async () => {
          await writeFile(ownerStagingPath, JSON.stringify(owner()), { encoding: 'utf8', mode: 0o600 })
          try { await chmod(ownerStagingPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
          await rename(ownerStagingPath, ownerPath)
        }
        await writeOwner()

        const heartbeat = setInterval(() => {
          if (released || heartbeatTask) return
          heartbeatTask = (async () => {
            try {
              const current = JSON.parse(await readFile(ownerPath, 'utf8'))
              if (current?.token !== token) throw new Error('Project write lease ownership changed unexpectedly.')
              await writeOwner()
            } catch (error) {
              failure = new ProjectIsolationError(
                'project_write_lock_lost',
                error instanceof Error
                  ? `Ensync Host lost the project write lease: ${error.message}`
                  : 'Ensync Host lost the project write lease.',
                409,
              )
              controller.abort(failure)
              clearInterval(heartbeat)
            } finally {
              heartbeatTask = null
            }
          })()
        }, this.#heartbeatMs)
        heartbeat.unref?.()

        return {
          signal: controller.signal,
          assertHeld() {
            if (failure) throw failure
          },
          release: async () => {
            if (released) return
            released = true
            clearInterval(heartbeat)
            await heartbeatTask?.catch(() => {})
            try {
              const current = JSON.parse(await readFile(ownerPath, 'utf8'))
              if (current?.token === token) await rm(lockPath, { recursive: true, force: true })
            } catch {
              // A missing or replaced lock is not authority to delete another owner's lease.
            }
          },
        }
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }
  }

  async #quarantineStaleLock(lockPath, ownerPath) {
    let freshest
    let ownerPid = null
    try {
      const [ownerInfo, lockInfo] = await Promise.all([stat(ownerPath), stat(lockPath)])
      freshest = Math.max(ownerInfo.mtimeMs, lockInfo.mtimeMs)
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
        if (Number.isInteger(owner?.pid) && owner.pid > 0) ownerPid = owner.pid
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
    // A live Host may be temporarily suspended while its provider child is
    // still mutating. Never steal that lease merely because timers paused.
    if (processIsAlive(ownerPid)) return false

    const quarantinePath = `${lockPath}.stale-${this.#uuid()}`
    try {
      await rename(lockPath, quarantinePath)
      await rm(quarantinePath, { recursive: true, force: true })
      return true
    } catch (error) {
      return error?.code === 'ENOENT'
    }
  }

  async #ensureWorkspace(repository, canonicalProjectPath, key) {
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
    } else {
      const branchCheck = await this.#git(['show-ref', '--verify', '--quiet', branchRef], {
        cwd: repository.repositoryPath,
        allowFailure: true,
      })
      const branchExists = branchCheck.exitCode === 0
      let startingPoint = repository.head
      if (!branchExists) {
        const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
          cwd: repository.repositoryPath,
        })
        const changedFiles = status.stdout.split('\0').filter(Boolean).length
        if (changedFiles > 0) {
          startingPoint = await this.#snapshotSharedCheckout(repository)
          seededFromSharedCheckout = true
        }
      }

      await mkdir(resolve(configuredPath, '..'), { recursive: true, mode: 0o700 })
      await this.#git(
        branchExists
          ? ['worktree', 'add', configuredPath, branch]
          : ['worktree', 'add', '-b', branch, configuredPath, startingPoint],
        {
          cwd: repository.repositoryPath,
          code: 'managed_worktree_create_failed',
          message: `Git could not create the protected Ensync worktree for ${branch}.`,
        },
      )
      worktreePath = await canonicalDirectory(
        configuredPath,
        'managed_worktree_create_failed',
        `The protected Ensync worktree for ${branch} was not created correctly.`,
      )
      if (seededFromSharedCheckout) {
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
    return {
      canonicalProjectPath,
      repositoryPath: worktreePath,
      projectPath: workspaceProjectPath,
      branch,
      reused,
      seededFromSharedCheckout,
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
      await this.#git(['add', '-A', '--', '.'], {
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

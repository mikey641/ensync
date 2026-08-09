import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { runGit } from './git.mjs'

const DEFAULT_LOCK_POLL_MS = 250
const DEFAULT_LOCK_STALE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 5_000
const MAX_WORKSPACE_KEY_CHARACTERS = 512
const WORKSPACE_KEY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

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
    const lease = await this.#acquireWorkspaceLease(repository.commonGitDirectory, key, options)

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

  async #acquireWorkspaceLease(commonGitDirectory, key, options) {
    const workspaceHash = digest(key)
    const lockParent = join(commonGitDirectory, 'ensync', 'workspace-write-locks')
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
        const owner = () => ({
          version: 2,
          token,
          pid: process.pid,
          workspaceHash,
          acquiredAt,
          heartbeatAt: new Date(this.#now()).toISOString(),
        })
        // Replace the record atomically so no heartbeat, release, or competing
        // Host can observe a file between truncate and write.
        const writeOwner = async () => {
          const pendingPath = `${ownerPath}.${this.#uuid()}.tmp`
          await writeFile(pendingPath, JSON.stringify(owner()), { encoding: 'utf8', mode: 0o600 })
          try { await chmod(pendingPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
          await rename(pendingPath, ownerPath)
        }
        await writeOwner()

        let heartbeatTicking = false
        const heartbeat = setInterval(() => {
          if (heartbeatTicking) return
          heartbeatTicking = true
          void (async () => {
            try {
              const current = JSON.parse(await readFile(ownerPath, 'utf8'))
              if (current?.token !== token) throw new Error('Protected workspace write lease ownership changed unexpectedly.')
              await writeOwner()
            } catch (error) {
              failure = new ProjectIsolationError(
                'workspace_write_lock_lost',
                error instanceof Error
                  ? `Ensync Host lost the protected workspace write lease: ${error.message}`
                  : 'Ensync Host lost the protected workspace write lease.',
                409,
              )
              controller.abort(failure)
              clearInterval(heartbeat)
            } finally {
              heartbeatTicking = false
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
    let branchExistedBeforeAcquire

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
          const conflicted = await this.#git(['diff', '--name-only', '--diff-filter=U'], {
            cwd: worktreePath,
            allowFailure: true,
          })
          const files = conflicted.stdout.split(/\r?\n/).filter(Boolean)
          await this.#git(['merge', '--abort'], { cwd: worktreePath, allowFailure: true })
          throw new ProjectIsolationError(
            'workspace_baseline_conflict',
            `New baseline changes conflict with this conversation's work in: ${files.join(', ') || 'unknown files'}. Resolve the conflict in the protected worktree at ${worktreePath}, commit it, then run again.`,
            409,
          )
        }
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

    const sharedHead = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: repository.repositoryPath })
    const sharedStatus = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repository.repositoryPath,
    })
    const shared = {
      repositoryPath: repository.repositoryPath,
      head: firstLine(sharedHead.stdout),
      statusEntries: sharedStatus.stdout.split('\0').filter(Boolean),
    }

    return {
      canonicalProjectPath,
      repositoryPath: worktreePath,
      projectPath: workspaceProjectPath,
      branch,
      reused,
      seededFromSharedCheckout,
      shared,
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

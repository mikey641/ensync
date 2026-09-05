import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { AgentWorktreeClient, resolveAgentWorktreeExecutable } from './agent-worktree-client.mjs'
import { ensureGitRepositoryBaseline, gitFailureMessage, runGit } from './git.mjs'


const BASELINE_TIMEOUT_MS = 120_000
const MAX_WORKSPACE_KEY_CHARACTERS = 512
const WORKSPACE_KEY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const OCCUPIED_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const OCCUPIED_NATIVE_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const FALLBACK_COMMIT_IDENTITY = Object.freeze({
  name: 'Ensync Agent',
  email: 'agent@ensync.local',
})

function agentCommitMessage(details, branch) {
  const lines = [`Ensync agent work (${details.outcome})`, '']
  if (details.provider) lines.push(`Provider: ${details.provider}`)
  if (details.jobId) lines.push(`Job: ${details.jobId}`)
  if (typeof details.turnId === 'string'
    && details.turnId.length <= 256
    && details.turnId.trim() === details.turnId
    && !/[\u0000-\u001f\u007f]/.test(details.turnId)) {
    lines.push(`Turn-ID: ${details.turnId}`)
  }
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

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

function statusEntries(value) {
  return String(value ?? '').split('\0').filter(Boolean)
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

function boundedOwner(value) {
  const owner = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    jobId: typeof owner.jobId === 'string' && OCCUPIED_JOB_ID_PATTERN.test(owner.jobId) ? owner.jobId : null,
    provider: typeof owner.provider === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(owner.provider)
      ? owner.provider
      : null,
    targetKind: owner.targetKind === 'local' || owner.targetKind === 'ssh' ? owner.targetKind : null,
    startedAt: typeof owner.startedAt === 'string' && Number.isFinite(Date.parse(owner.startedAt))
      ? owner.startedAt
      : null,
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
    const information = await stat(canonical)
    if (!information.isDirectory()) throw new Error('not a directory')
    return canonical
  } catch {
    throw new ProjectIsolationError(code, message, 409)
  }
}

function parseWorktrees(value) {
  const worktrees = []
  let current = null
  for (const line of String(value ?? '').split(/\r?\n/)) {
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

function cancellationError() {
  return new ProjectIsolationError(
    'run_cancelled',
    'Run stopped before Ensync Host prepared the protected conversation workspace.',
    499,
  )
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError()
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
 * Gives each conversation one stable worktree. agent-worktree owns workspace
 * creation; this service only records active ownership inside the single Host
 * process. There are no filesystem leases, heartbeats, polling loops, or
 * baseline merges on the provider's critical path.
 */
export class ProjectIsolationService {
  #rootPath
  #gitExecutable
  #gitRunner
  #autoInitializeGit
  #homePath
  #now
  #client
  #clientPromise = null
  #active = new Map()
  #operationContext = new AsyncLocalStorage()
  #preparationChains = new Map()

  constructor(options = {}) {
    const rootPath = options.rootPath ?? join(homedir(), '.ensync', 'agent-workspaces-v2')
    if (typeof rootPath !== 'string' || !isAbsolute(rootPath)) {
      throw new TypeError('The Ensync agent-workspace root must be an absolute path.')
    }
    this.#rootPath = resolve(rootPath)
    this.#gitExecutable = options.gitExecutable ?? 'git'
    this.#gitRunner = options.gitRunner ?? runGit
    this.#autoInitializeGit = options.autoInitializeGit !== false
    this.#homePath = options.homePath
    this.#now = options.now ?? Date.now
    this.#client = options.agentWorktreeClient ?? null
  }

  async acquire(projectPath, rawWorkspaceKey, options = {}) {
    const admission = await this.tryAcquireOrDescribe(projectPath, rawWorkspaceKey, options)
    if (admission.disposition === 'acquired') return admission.lease
    throw new ProjectIsolationError(
      'workspace_in_use',
      'This conversation already has a running job. Continue that job or wait for it to finish.',
      409,
    )
  }

  tryAcquireOrDescribe(projectPath, rawWorkspaceKey, options = {}) {
    return this.#operationContext.run(
      { signal: options.signal },
      () => this.#tryAcquireOrDescribe(projectPath, rawWorkspaceKey, options),
    )
  }

  async #tryAcquireOrDescribe(projectPath, rawWorkspaceKey, options = {}) {
    const key = workspaceKey(rawWorkspaceKey)
    throwIfCancelled(options.signal)
    const canonicalProjectPath = await canonicalDirectory(
      projectPath,
      'invalid_project',
      'The selected project folder does not exist or cannot be accessed.',
    )
    const repository = await this.#repository(canonicalProjectPath)
    const ownershipKey = `${repository.commonGitDirectory}\0${digest(key)}`
    const occupied = this.#active.get(ownershipKey)
    if (occupied) return { disposition: 'occupied', owner: { ...occupied.owner } }

    const record = { owner: boundedOwner(options.owner), released: false }
    this.#active.set(ownershipKey, record)
    const controller = new AbortController()
    const assertHeld = () => {
      if (record.released || this.#active.get(ownershipKey) !== record) {
        throw new ProjectIsolationError(
          'workspace_ownership_lost',
          'Ensync Host no longer owns this conversation workspace.',
          409,
        )
      }
    }
    const release = async () => {
      if (record.released) return { removed: false, reason: 'The conversation workspace was already released.' }
      record.released = true
      const removed = this.#active.get(ownershipKey) === record
      if (removed) this.#active.delete(ownershipKey)
      return { removed, reason: removed ? null : 'The conversation workspace ownership had already changed.' }
    }
    const lease = {
      signal: controller.signal,
      assertHeld,
      describeOwner: () => ({ ...record.owner }),
      updateOwner: async (patch = {}) => {
        assertHeld()
        record.owner = boundedOwner({ ...record.owner, ...patch })
        return { ...record.owner }
      },
      release,
    }

    try {
      throwIfCancelled(options.signal)
      lease.workspace = await this.#withRepositoryPreparation(
        repository.commonGitDirectory,
        () => this.#ensureWorkspace(repository, canonicalProjectPath, key),
      )
      assertHeld()
      return { disposition: 'acquired', lease }
    } catch (error) {
      await release()
      throw error
    }
  }

  async commitAgentWork(workspace, details = {}) {
    return this.#commitWorktree(workspace.repositoryPath, workspace.branch, workspace.commonGitDirectory, {
      ...details,
      outcome: details.outcome ?? 'failed',
    })
  }

  async checkSharedCheckout(workspace) {
    const before = workspace?.shared
    if (!before) return { available: false }
    try {
      const head = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: before.repositoryPath })
      const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: before.repositoryPath,
      })
      const afterHead = firstLine(head.stdout)
      const afterEntries = statusEntries(status.stdout)
      const headMoved = afterHead !== before.head
      const statusMoved = afterEntries.join('\n') !== before.statusEntries.join('\n')
      let landed = false
      if (headMoved) {
        const publishedMessage = await this.#git(['show', '-s', '--format=%B', afterHead], {
          cwd: before.repositoryPath,
          allowFailure: true,
        })
        landed = publishedMessage.exitCode === 0
          && /(?:^|\n)Ensync-Landing: true(?:\n|$)/.test(publishedMessage.stdout)
        if (!landed) {
          const log = await this.#git(['log', '--format=%s', `${before.head}..${afterHead}`], {
            cwd: before.repositoryPath,
            allowFailure: true,
          })
          const subjects = log.exitCode === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : []
          landed = subjects.length > 0 && subjects.every((subject) => (
            subject.startsWith("Merge branch 'ensync/landing-trains/")
            || subject.startsWith('Ensync automatic landing')
          ))
        }
      }
      const afterPaths = new Set(afterEntries.map((entry) => entry.slice(3)))
      const destructive = !headMoved && before.statusEntries.some((entry) => !afterPaths.has(entry.slice(3)))
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

  /**
   * Checks whether the conversation worktree for the given project and workspace
   * key has no uncommitted changes. Used by the chat job service to decide
   * whether a failed run can be safely auto-continued with a fresh session.
   */
  async isWorktreeClean(projectPath, rawWorkspaceKey) {
    try {
      const key = workspaceKey(rawWorkspaceKey)
      const canonicalProjectPath = await canonicalDirectory(
        projectPath,
        'invalid_project',
        '',
      )
      const repository = await this.#repository(canonicalProjectPath)
      const branch = `ensync/chat-${digest(key)}`
      const branchRef = `refs/heads/${branch}`
      const worktreeList = await this.#git(['worktree', 'list', '--porcelain'], {
        cwd: repository.repositoryPath,
      })
      const registered = parseWorktrees(worktreeList.stdout).find((wt) => wt.branch === branchRef)
      if (!registered || registered.prunable) return false
      const wtPath = await canonicalDirectory(registered.path, 'managed_worktree_missing', '')
      const status = await this.#git(['status', '--porcelain'], { cwd: wtPath })
      return status.stdout.trim() === ''
    } catch {
      return false
    }
  }

  async #clientForRun() {
    if (this.#client) return this.#client
    this.#clientPromise ??= (async () => new AgentWorktreeClient({
      executable: await resolveAgentWorktreeExecutable(),
      storagePath: this.#rootPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: FALLBACK_COMMIT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: FALLBACK_COMMIT_IDENTITY.email,
        GIT_COMMITTER_NAME: FALLBACK_COMMIT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: FALLBACK_COMMIT_IDENTITY.email,
        GIT_EDITOR: 'true',
        GIT_MERGE_AUTOEDIT: 'no',
      },
    }))()
    this.#client = await this.#clientPromise
    return this.#client
  }

  async #commitWorktree(worktreePath, branch, expectedCommonGitDirectory, details) {
    await this.#assertWorkspaceIdentity(worktreePath, branch, expectedCommonGitDirectory)
    const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: worktreePath,
      code: 'agent_work_commit_failed',
      message: `Ensync could not inspect the protected worktree for ${branch}.`,
    })
    const changedFiles = statusEntries(status.stdout).length
    if (changedFiles === 0) {
      const head = await this.#verifiedSnapshotHead(worktreePath, branch, expectedCommonGitDirectory)
      return { committed: false, changedFiles: 0, head }
    }
    const timestamp = new Date(this.#now()).toISOString()
    const [configuredName, configuredEmail] = await Promise.all([
      this.#git(['config', '--get', 'user.name'], { cwd: worktreePath, allowFailure: true }),
      this.#git(['config', '--get', 'user.email'], { cwd: worktreePath, allowFailure: true }),
    ])
    const identity = {
      name: firstLine(configuredName.stdout) || FALLBACK_COMMIT_IDENTITY.name,
      email: firstLine(configuredEmail.stdout) || FALLBACK_COMMIT_IDENTITY.email,
    }
    const env = {
      ...(await (await this.#clientForRun()).gitEnvironment(identity)),
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
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
    const head = await this.#verifiedSnapshotHead(worktreePath, branch, expectedCommonGitDirectory)
    return { committed: true, changedFiles, head }
  }

  async #verifiedSnapshotHead(worktreePath, branch, expectedCommonGitDirectory) {
    const [status, head, branchHead] = await Promise.all([
      this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath }),
      this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath }),
      this.#git(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: worktreePath }),
    ])
    await this.#assertWorkspaceIdentity(worktreePath, branch, expectedCommonGitDirectory)
    const headSha = firstLine(head.stdout)
    if (
      statusEntries(status.stdout).length > 0
      || !headSha
      || headSha !== firstLine(branchHead.stdout)
    ) {
      throw new ProjectIsolationError(
        'agent_work_snapshot_incomplete',
        'The protected worktree changed while Ensync was saving the completed run, so no incomplete snapshot was queued.',
      )
    }
    return headSha
  }

  async #assertWorkspaceIdentity(worktreePath, branch, expectedCommonGitDirectory) {
    const [actualBranch, commonResult] = await Promise.all([
      this.#git(['symbolic-ref', '--quiet', 'HEAD'], {
        cwd: worktreePath,
        allowFailure: true,
      }),
      this.#git(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: worktreePath,
        allowFailure: true,
      }),
    ])
    if (actualBranch.exitCode !== 0 || firstLine(actualBranch.stdout) !== `refs/heads/${branch}` || commonResult.exitCode !== 0) {
      throw new ProjectIsolationError(
        'managed_worktree_mismatch',
        `The protected Ensync worktree must remain on ${branch}; its changes were not queued for landing.`,
      )
    }
    const commonValue = firstLine(commonResult.stdout)
    const actualCommon = await canonicalDirectory(
      isAbsolute(commonValue) ? commonValue : resolve(worktreePath, commonValue),
      'managed_worktree_mismatch',
      'The protected Ensync worktree no longer belongs to the selected Git repository.',
    )
    if (!samePath(actualCommon, expectedCommonGitDirectory)) {
      throw new ProjectIsolationError(
        'managed_worktree_mismatch',
        'The protected Ensync worktree no longer belongs to the selected Git repository.',
      )
    }
  }

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
      message: 'Local agent execution requires a Git repository so Ensync can isolate changes from the shared checkout.',
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
    const common = await this.#git(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repositoryPath,
      allowFailure: true,
    })
    const commonFallback = common.exitCode === 0
      ? common
      : await this.#git(['rev-parse', '--git-common-dir'], { cwd: repositoryPath })
    const commonValue = firstLine(commonFallback.stdout)
    const commonGitDirectory = await canonicalDirectory(
      isAbsolute(commonValue) ? commonValue : resolve(repositoryPath, commonValue),
      'project_isolation_required',
      'Ensync Host could not verify the repository shared Git directory.',
    )
    const target = await this.#captureRepositoryTarget(repositoryPath)
    const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repositoryPath,
    })
    const dirty = statusEntries(status.stdout)
    // Uncommitted changes in the shared checkout do not block chat creation.
    // The agent works in an isolated worktree branched from HEAD, so it never
    // sees or touches these changes. The landing integrator has its own clean-
    // checkout guard that waits until the user has committed or stashed before
    // merging agent work back into the target branch. Blocking chat creation
    // here only forced the user to leave the app to commit or stash every time
    // they had work-in-progress, without protecting anything the worktree
    // isolation and landing guards do not already cover.
    return {
      repositoryPath,
      commonGitDirectory,
      head: target.head,
      branch: target.branch,
      statusEntries: dirty,
    }
  }

  async #captureRepositoryTarget(repositoryPath) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.#git(['symbolic-ref', '--quiet', 'HEAD'], {
        cwd: repositoryPath,
        code: 'project_baseline_unavailable',
        message: 'Check out the branch this conversation should land into before starting an Ensync chat.',
      })
      const branchRef = firstLine(before.stdout)
      const branch = branchRef.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : ''
      const head = await this.#git([
        'rev-parse', '--verify', `refs/heads/${branch}^{commit}`,
      ], {
        cwd: repositoryPath,
        code: 'project_baseline_unavailable',
        message: 'Create an initial Git commit before starting an isolated Ensync agent workspace.',
      })
      const after = await this.#git(['symbolic-ref', '--quiet', 'HEAD'], {
        cwd: repositoryPath,
        code: 'project_baseline_unavailable',
        message: 'Check out the branch this conversation should land into before starting an Ensync chat.',
      })
      if (branch && firstLine(after.stdout) === branchRef) return { branch, head: firstLine(head.stdout) }
    }
    throw new ProjectIsolationError(
      'project_target_changed',
      'The checked-out branch changed while Ensync prepared the conversation workspace. Retry after the checkout is stable.',
      409,
    )
  }

  async #ensureWorkspace(repository, canonicalProjectPath, key) {
    throwIfCancelled(this.#signal())
    const branch = `ensync/chat-${digest(key)}`
    const branchRef = `refs/heads/${branch}`
    const worktreeList = await this.#git(['worktree', 'list', '--porcelain'], { cwd: repository.repositoryPath })
    const registered = parseWorktrees(worktreeList.stdout).find((worktree) => worktree.branch === branchRef)
    let worktreePath
    let reused = false
    let targetBranch
    let targetBaseSha = repository.head

    if (registered) {
      if (registered.prunable) {
        throw new ProjectIsolationError(
          'managed_worktree_missing',
          `The protected Ensync branch ${branch} points to a missing worktree. Remove the stale Git worktree registration and retry.`,
        )
      }
      worktreePath = await canonicalDirectory(
        registered.path,
        'managed_worktree_missing',
        `The protected Ensync worktree for ${branch} is missing or inaccessible.`,
      )
      reused = true
      targetBranch = await this.#existingTargetBranch(worktreePath, branch, repository.branch)
      targetBaseSha = await this.#existingTargetBaseSha(worktreePath, branch)
    } else {
      const branchExists = await this.#git(['show-ref', '--verify', '--quiet', branchRef], {
        cwd: repository.repositoryPath,
        allowFailure: true,
      })
      if (branchExists.exitCode === 0) {
        throw new ProjectIsolationError(
          'managed_worktree_missing',
          `The protected branch ${branch} exists without a registered worktree. Its commits were preserved; restore or attach a worktree for that branch before retrying.`,
        )
      }
      if (!repository.branch) {
        throw new ProjectIsolationError(
          'project_baseline_unavailable',
          'The shared checkout is detached. Check out the branch Ensync should land into before starting a chat.',
          409,
        )
      }
      const immutableBase = await this.#immutableBaseBranch(
        repository.repositoryPath,
        repository.head,
      )
      // Persist the real user target before `wt new`. agent-worktree records
      // the immutable helper ref as its base, so a Host exit after creation
      // must not make restart mistake that helper for the landing target.
      await this.#git(['config', `branch.${branch}.ensyncTargetBranch`, repository.branch], {
        cwd: repository.repositoryPath,
      })
      await this.#git(['config', `branch.${branch}.ensyncTargetBaseSha`, repository.head], {
        cwd: repository.repositoryPath,
      })
      let created
      try {
        created = await (await this.#clientForRun()).create({
          repositoryPath: repository.repositoryPath,
          branch,
          // Pin creation to the inspected commit. A branch name could move
          // between inspection and `wt new`, making later landing metadata lie
          // about which target history the conversation actually inherited.
          base: immutableBase,
          signal: this.#signal(),
        })
      } catch (error) {
        throwIfCancelled(this.#signal())
        throw new ProjectIsolationError(
          'managed_worktree_create_failed',
          error instanceof Error ? `agent-worktree could not create ${branch}: ${error.message}` : `agent-worktree could not create ${branch}.`,
          409,
        )
      }
      worktreePath = await canonicalDirectory(
        created?.path,
        'managed_worktree_create_failed',
        `agent-worktree did not create a usable worktree for ${branch}.`,
      )
      targetBranch = repository.branch
    }

    const isolatedCommon = await this.#git(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: worktreePath,
      allowFailure: true,
    })
    const isolatedFallback = isolatedCommon.exitCode === 0
      ? isolatedCommon
      : await this.#git(['rev-parse', '--git-common-dir'], { cwd: worktreePath })
    const isolatedValue = firstLine(isolatedFallback.stdout)
    const isolatedCommonPath = await canonicalDirectory(
      isAbsolute(isolatedValue) ? isolatedValue : resolve(worktreePath, isolatedValue),
      'managed_worktree_mismatch',
      'The protected Ensync worktree no longer belongs to the selected Git repository.',
    )
    if (isolatedCommonPath !== repository.commonGitDirectory) {
      throw new ProjectIsolationError(
        'managed_worktree_mismatch',
        'The protected Ensync worktree belongs to a different Git repository.',
      )
    }
    const actualBranch = await this.#git(['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: worktreePath,
      code: 'managed_worktree_mismatch',
      message: 'The protected Ensync worktree is detached or on an unexpected branch.',
    })
    if (firstLine(actualBranch.stdout) !== `refs/heads/${branch}`) {
      throw new ProjectIsolationError(
        'managed_worktree_mismatch',
        `The protected Ensync worktree must remain on ${branch}.`,
      )
    }

    if (reused) {
      const leftovers = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath })
      if (statusEntries(leftovers.stdout).length > 0) {
        await this.#commitWorktree(worktreePath, branch, repository.commonGitDirectory, { outcome: 'recovered' })
      }
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

    const worktreeStatus = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath })
    const worktreeHead = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath })
    const currentHead = firstLine(worktreeHead.stdout)
    const targetHeadResult = await this.#git(['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`], {
      cwd: worktreePath,
      code: 'managed_worktree_target_unavailable',
      message: `The saved target branch ${targetBranch} no longer exists. Restore it before continuing this conversation.`,
    })
    const targetHead = firstLine(targetHeadResult.stdout)
    const [baseAvailable, baseInWorkspace, baseInTarget] = await Promise.all([
      this.#git(['cat-file', '-e', `${targetBaseSha}^{commit}`], { cwd: worktreePath, allowFailure: true }),
      this.#git(['merge-base', '--is-ancestor', targetBaseSha, currentHead], { cwd: worktreePath, allowFailure: true }),
      this.#git(['merge-base', '--is-ancestor', targetBaseSha, targetHead], { cwd: worktreePath, allowFailure: true }),
    ])
    if (baseAvailable.exitCode !== 0 || baseInWorkspace.exitCode !== 0 || baseInTarget.exitCode !== 0) {
      throw new ProjectIsolationError(
        'managed_worktree_target_rewritten',
        `The saved target history for ${branch} was rewritten. Start a new conversation rather than reintroducing commits removed from ${targetBranch}.`,
        409,
      )
    }
    await this.#git(['config', `branch.${branch}.ensyncTargetBranch`, targetBranch], { cwd: worktreePath })
    await this.#git(['config', `branch.${branch}.ensyncTargetBaseSha`, targetBaseSha], { cwd: worktreePath })
    const changes = statusEntries(worktreeStatus.stdout)
    const integrated = await this.#git(['merge-base', '--is-ancestor', currentHead, repository.head], {
      cwd: worktreePath,
      allowFailure: true,
    })
    const count = await this.#git(['rev-list', '--count', `${repository.head}..${currentHead}`], {
      cwd: worktreePath,
      allowFailure: true,
    })
    const unintegratedCommits = count.exitCode === 0 ? Number.parseInt(firstLine(count.stdout), 10) : null
    return {
      canonicalProjectPath,
      commonGitDirectory: repository.commonGitDirectory,
      repositoryPath: worktreePath,
      projectPath: workspaceProjectPath,
      branch,
      reused,
      seededFromSharedCheckout: false,
      baselineConflict: null,
      shared: {
        repositoryPath: repository.repositoryPath,
        head: repository.head,
        statusEntries: repository.statusEntries,
      },
      base: {
        sha: currentHead,
        canonicalSha: targetBaseSha,
        source: reused ? 'conversation_branch' : 'canonical_head',
        reason: null,
        remote: null,
        branch: targetBranch,
        refreshed: false,
      },
      integration: {
        canonicalSha: repository.head,
        integrated: integrated.exitCode === 0,
        unintegratedCommits: Number.isInteger(unintegratedCommits) ? unintegratedCommits : null,
      },
      gitBefore: {
        branch,
        head: currentHead,
        dirty: changes.length > 0,
        changedFiles: changes.length,
        checkedAt: new Date(this.#now()).toISOString(),
      },
    }
  }

  async #existingTargetBranch(worktreePath, branch, checkedOutTargetBranch) {
    const migrationKey = `branch.${branch}.ensyncTargetBranch`
    const migrated = await this.#git(['config', '--get', migrationKey], {
      cwd: worktreePath,
      allowFailure: true,
    })
    if (migrated.exitCode === 0 && firstLine(migrated.stdout)) return firstLine(migrated.stdout)

    try {
      const managed = await (await this.#clientForRun()).status(worktreePath, {
        signal: this.#signal(),
      })
      if (typeof managed?.base_branch === 'string' && managed.base_branch) {
        const managedTarget = managed.base_branch
        const exists = await this.#git(['show-ref', '--verify', '--quiet', `refs/heads/${managedTarget}`], {
          cwd: worktreePath,
          allowFailure: true,
        })
        if (exists.exitCode === 0) return managedTarget
      }
    } catch {
      // Raw worktrees from older Ensync builds have no agent-worktree metadata.
    }

    const reflog = await this.#git(['reflog', 'show', '--format=%gs', branch], {
      cwd: worktreePath,
      allowFailure: true,
    })
    const createdFrom = reflog.exitCode === 0
      ? reflog.stdout.split(/\r?\n/)
          .map((line) => line.match(/^branch: Created from (.+)$/)?.[1]?.trim() ?? null)
          .find(Boolean)
      : null
    if (createdFrom) {
      const exists = await this.#git(['show-ref', '--verify', '--quiet', `refs/heads/${createdFrom}`], {
        cwd: worktreePath,
        allowFailure: true,
      })
      if (exists.exitCode === 0) {
        const persisted = await this.#git(['config', migrationKey, createdFrom], {
          cwd: worktreePath,
          allowFailure: true,
        })
        if (persisted.exitCode === 0) return createdFrom
      }
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(createdFrom)) {
        const containing = await this.#git([
          'for-each-ref', `--contains=${createdFrom}`, '--format=%(refname)',
          'refs/heads', 'refs/remotes',
        ], { cwd: worktreePath, allowFailure: true })
        const refs = containing.exitCode === 0
          ? containing.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
          : []
        const candidates = new Set()
        for (const ref of refs) {
          if (ref.startsWith('refs/heads/') && !ref.startsWith('refs/heads/ensync/')) {
            candidates.add(ref.slice('refs/heads/'.length))
            continue
          }
          const remote = ref.match(/^refs\/remotes\/[^/]+\/(.+)$/)?.[1]
          if (!remote) continue
          const local = await this.#git(['show-ref', '--verify', '--quiet', `refs/heads/${remote}`], {
            cwd: worktreePath,
            allowFailure: true,
          })
          if (local.exitCode === 0) candidates.add(remote)
        }
        const candidate = typeof checkedOutTargetBranch === 'string'
          && candidates.has(checkedOutTargetBranch)
          ? checkedOutTargetBranch
          : candidates.size === 1
            ? [...candidates][0]
            : null
        if (candidate) {
          const persisted = await this.#git(['config', migrationKey, candidate], {
            cwd: worktreePath,
            allowFailure: true,
          })
          if (persisted.exitCode === 0) return candidate
        }
      }
    }
    throw new ProjectIsolationError(
      'managed_worktree_target_unavailable',
      `The existing conversation worktree ${branch} has no provable target branch. Start a new conversation rather than guessing where its work should land.`,
      409,
    )
  }

  async #existingTargetBaseSha(worktreePath, branch) {
    const migrationKey = `branch.${branch}.ensyncTargetBaseSha`
    const migrated = await this.#git(['config', '--get', migrationKey], {
      cwd: worktreePath,
      allowFailure: true,
    })
    const migratedSha = firstLine(migrated.stdout).toLowerCase()
    if (migrated.exitCode === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(migratedSha)) {
      return migratedSha
    }

    const reflog = await this.#git([
      'reflog', 'show', '--format=%H%x09%gs', branch,
    ], {
      cwd: worktreePath,
      allowFailure: true,
    })
    if (reflog.exitCode === 0) {
      for (const record of reflog.stdout.split(/\r?\n/)) {
        const separator = record.indexOf('\t')
        const sha = separator === -1 ? '' : record.slice(0, separator)
        const message = separator === -1 ? '' : record.slice(separator + 1)
        if (
          /^branch: Created from .+$/.test(message ?? '')
          && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha ?? '')
        ) {
          return sha.toLowerCase()
        }
      }
    }
    throw new ProjectIsolationError(
      'managed_worktree_target_unavailable',
      `The existing conversation worktree ${branch} has no provable target base commit. Start a new conversation rather than guessing which history it inherited.`,
      409,
    )
  }

  async #immutableBaseBranch(repositoryPath, sha) {
    const branch = `ensync/workspace-bases/${sha.toLowerCase()}`
    const ref = `refs/heads/${branch}`
    const existing = await this.#git(['rev-parse', '--verify', ref], {
      cwd: repositoryPath,
      allowFailure: true,
    })
    if (existing.exitCode === 0) {
      if (firstLine(existing.stdout).toLowerCase() === sha.toLowerCase()) return branch
      throw new ProjectIsolationError(
        'managed_worktree_create_failed',
        `The immutable workspace base ${ref} no longer names ${sha}.`,
        409,
      )
    }
    const environment = await (await this.#clientForRun()).gitEnvironment()
    const created = await this.#git([
      '-c', 'core.hooksPath=/dev/null',
      'update-ref', ref, sha, '0'.repeat(sha.length),
    ], { cwd: repositoryPath, env: environment, allowFailure: true })
    if (created.exitCode === 0) return branch
    const raced = await this.#git(['rev-parse', '--verify', ref], {
      cwd: repositoryPath,
      allowFailure: true,
    })
    if (raced.exitCode === 0 && firstLine(raced.stdout).toLowerCase() === sha.toLowerCase()) return branch
    throw new ProjectIsolationError(
      'managed_worktree_create_failed',
      `Git could not preserve the immutable workspace base ${sha}.`,
      409,
    )
  }

  async #git(args, options = {}) {
    let result
    try {
      result = await this.#gitRunner(args, {
        cwd: options.cwd,
        env: options.env,
        gitExecutable: this.#gitExecutable,
        timeoutMs: options.timeoutMs,
        signal: options.signal ?? this.#signal(),
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

  #signal() {
    return this.#operationContext.getStore()?.signal
  }

  async #withRepositoryPreparation(repositoryKey, operation) {
    const previous = this.#preparationChains.get(repositoryKey) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const tail = result.catch(() => {})
    this.#preparationChains.set(repositoryKey, tail)
    try {
      return await result
    } finally {
      if (this.#preparationChains.get(repositoryKey) === tail) {
        this.#preparationChains.delete(repositoryKey)
      }
    }
  }
}

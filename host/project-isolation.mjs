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

const AGENT_COMMIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'Ensync Agent',
  GIT_AUTHOR_EMAIL: 'agent@ensync.local',
  GIT_COMMITTER_NAME: 'Ensync Agent',
  GIT_COMMITTER_EMAIL: 'agent@ensync.local',
})

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

  async tryAcquireOrDescribe(projectPath, rawWorkspaceKey, options = {}) {
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
      lease.workspace = await this.#ensureWorkspace(repository, canonicalProjectPath, key)
      assertHeld()
      return { disposition: 'acquired', lease }
    } catch (error) {
      await release()
      throw error
    }
  }

  async commitAgentWork(workspace, details = {}) {
    return this.#commitWorktree(workspace.repositoryPath, workspace.branch, {
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

  async #clientForRun() {
    if (this.#client) return this.#client
    this.#clientPromise ??= (async () => new AgentWorktreeClient({
      executable: await resolveAgentWorktreeExecutable(),
      storagePath: this.#rootPath,
      env: {
        ...process.env,
        ...AGENT_COMMIT_IDENTITY,
        GIT_EDITOR: 'true',
        GIT_MERGE_AUTOEDIT: 'no',
      },
    }))()
    this.#client = await this.#clientPromise
    return this.#client
  }

  async #commitWorktree(worktreePath, branch, details) {
    const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: worktreePath,
      code: 'agent_work_commit_failed',
      message: `Ensync could not inspect the protected worktree for ${branch}.`,
    })
    const changedFiles = statusEntries(status.stdout).length
    if (changedFiles === 0) {
      const head = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath })
      return { committed: false, changedFiles: 0, head: firstLine(head.stdout) }
    }
    const timestamp = new Date(this.#now()).toISOString()
    const env = {
      ...AGENT_COMMIT_IDENTITY,
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
    const head = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath })
    return { committed: true, changedFiles, head: firstLine(head.stdout) }
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
    const head = await this.#git(['rev-parse', '--verify', 'HEAD'], {
      cwd: repositoryPath,
      code: 'project_baseline_unavailable',
      message: 'Create an initial Git commit before starting an isolated Ensync agent workspace.',
    })
    const branch = await this.#git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repositoryPath,
      allowFailure: true,
    })
    const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repositoryPath,
    })
    const dirty = statusEntries(status.stdout)
    if (dirty.length > 0) {
      throw new ProjectIsolationError(
        'shared_checkout_dirty',
        `The shared checkout has ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}. Commit or stash them before starting an Ensync chat so no hidden history is created.`,
        409,
      )
    }
    return {
      repositoryPath,
      commonGitDirectory,
      head: firstLine(head.stdout),
      branch: firstLine(branch.stdout) || null,
      statusEntries: dirty,
    }
  }

  async #ensureWorkspace(repository, canonicalProjectPath, key) {
    const branch = `ensync/chat-${digest(key)}`
    const branchRef = `refs/heads/${branch}`
    const worktreeList = await this.#git(['worktree', 'list', '--porcelain'], { cwd: repository.repositoryPath })
    const registered = parseWorktrees(worktreeList.stdout).find((worktree) => worktree.branch === branchRef)
    let worktreePath
    let reused = false

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
    } else {
      const branchExists = await this.#git(['show-ref', '--verify', '--quiet', branchRef], {
        cwd: repository.repositoryPath,
        allowFailure: true,
      })
      if (branchExists.exitCode === 0) {
        throw new ProjectIsolationError(
          'managed_worktree_missing',
          `The protected branch ${branch} exists without a registered worktree. Remove that orphan branch or restore its worktree before retrying.`,
        )
      }
      if (!repository.branch) {
        throw new ProjectIsolationError(
          'project_baseline_unavailable',
          'The shared checkout is detached. Check out the branch Ensync should land into before starting a chat.',
          409,
        )
      }
      let created
      try {
        created = await (await this.#clientForRun()).create({
          repositoryPath: repository.repositoryPath,
          branch,
          base: repository.branch,
        })
      } catch (error) {
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

    if (reused) {
      const leftovers = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath })
      if (statusEntries(leftovers.stdout).length > 0) {
        await this.#commitWorktree(worktreePath, branch, { outcome: 'recovered' })
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
        canonicalSha: repository.head,
        source: reused ? 'conversation_branch' : 'canonical_head',
        reason: null,
        remote: null,
        branch: repository.branch,
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
}

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { runGit, validateRepositoryLocation } from './git.mjs'

const DEFAULT_LOCK_POLL_MS = 250
const DEFAULT_LOCK_STALE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 5_000
const MAX_UNPROVEN_LEASE_OBSERVATIONS = 3
const DEFAULT_BASE_FETCH_TTL_MS = 60_000
const DEFAULT_FETCH_TIMEOUT_MS = 120_000
const PREFERRED_CANONICAL_REMOTE = 'origin'
const CANONICAL_BRANCH_FALLBACKS = ['main', 'master']
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
    return this.#acquireLease(join(commonGitDirectory, 'ensync', 'workspace-write-locks'), digest(key), options)
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
        let renewalSequence = 0
        const writeOwner = async () => {
          // Replace the owner record atomically, through a path unique to this
          // renewal. A reader that catches a truncated file mid-renewal must
          // never be able to conclude that this lease was stolen and kill a
          // live provider run.
          renewalSequence += 1
          const ownerTempPath = join(lockPath, `owner.${token}.${renewalSequence}.json`)
          await writeFile(ownerTempPath, JSON.stringify(owner()), { encoding: 'utf8', mode: 0o600 })
          try { await chmod(ownerTempPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
          await rename(ownerTempPath, ownerPath)
        }
        await writeOwner()

        let unprovenObservations = 0
        const loseLease = (message) => {
          failure = new ProjectIsolationError('workspace_write_lock_lost', message, 409)
          controller.abort(failure)
          clearInterval(heartbeat)
        }
        const observeUnproven = (error, detail) => {
          unprovenObservations += 1
          if (unprovenObservations < MAX_UNPROVEN_LEASE_OBSERVATIONS) return
          loseLease(`Ensync Host lost the protected workspace write lease: ${error instanceof Error ? error.message : detail}`)
        }

        let renewing = false
        const heartbeat = setInterval(() => {
          if (renewing) return
          renewing = true
          void (async () => {
            try {
              let current
              try {
                current = JSON.parse(await readFile(ownerPath, 'utf8'))
              } catch (error) {
                // Only a readable record naming a different owner proves a loss.
                observeUnproven(error, 'the lease record could not be read.')
                return
              }
              if (current?.token !== token) {
                loseLease('Ensync Host lost the protected workspace write lease: another Ensync Host took ownership of this conversation workspace.')
                return
              }
              unprovenObservations = 0
              try {
                await writeOwner()
              } catch (error) {
                observeUnproven(error, 'the lease record could not be renewed.')
              }
            } finally {
              renewing = false
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
      digest(`${repository.commonGitDirectory} ${remote}`),
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
   * base. This merges rather than rebases so in-progress uncommitted agent work
   * is never rewritten, and it refuses instead of forcing whenever Git reports
   * a conflict or an unfinished operation.
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

    const merged = await this.#git(['merge', '--no-edit', base.sha], {
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
    const applied = await this.#git(['cherry-pick', '--no-commit', snapshot], { cwd: worktreePath, allowFailure: true })
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
    let baseRefresh

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
      baseRefresh = await this.#refreshReusedWorkspace(worktreePath, branch, base)
    } else {
      const branchCheck = await this.#git(['show-ref', '--verify', '--quiet', branchRef], {
        cwd: repository.repositoryPath,
        allowFailure: true,
      })
      const branchExists = branchCheck.exitCode === 0
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
        await this.#git(
          branchExists
            ? ['worktree', 'add', configuredPath, branch]
            : ['worktree', 'add', '-b', branch, configuredPath, revision],
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
      baseRefresh = { refreshed: base.source === 'remote_default_branch', reason: base.reason }

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
    if (!baseRefresh.refreshed && baseRefresh.reason && base.source === 'remote_default_branch') {
      // Ensync could not bring this existing worktree onto the canonical commit,
      // so it still stands on its own base. Report that rather than the commit
      // Ensync wanted it to have.
      base.source = 'base_refresh_deferred'
      base.sha = firstLine(head.stdout)
      base.reason = baseRefresh.reason
    }
    return {
      canonicalProjectPath,
      repositoryPath: worktreePath,
      projectPath: workspaceProjectPath,
      branch,
      reused,
      seededFromSharedCheckout,
      base: {
        sha: base.sha,
        canonicalSha: base.canonicalSha,
        source: base.source,
        reason: baseRefresh.reason ?? base.reason,
        remote: base.remote,
        branch: base.branch,
        refreshed: baseRefresh.refreshed,
      },
      integration: await this.#integrationState(worktreePath, base.canonicalSha),
      gitBefore: {
        branch,
        head: firstLine(head.stdout),
        dirty: changedFiles > 0,
        changedFiles,
        checkedAt: new Date(this.#now()).toISOString(),
      },
    }
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

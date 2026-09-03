import { spawn } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { inspectProject } from './projects.mjs'
import { validateProjectPath } from './chat.mjs'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_TERMINATION_GRACE_MS = 2_000
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_REPOSITORY_URL_LENGTH = 4_096
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class GitWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'GitWorkflowError'
    this.code = options.code ?? 'git_error'
    this.status = options.status ?? 400
  }
}

function isWithin(root, target) {
  const child = relative(root, target)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

async function canonicalAllowedRoots(allowedRoots) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return null
  const roots = []
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !isAbsolute(root)) continue
    try {
      roots.push(await realpath(root))
    } catch {
      // A configured root that does not exist cannot authorize a destination.
    }
  }
  return roots
}

function redactGitText(value) {
  return String(value)
    .replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[credentials]@')
    .replace(/\b(https?:\/\/)[^\s]+/gi, (url) => {
      try {
        const parsed = new URL(url)
        parsed.username = ''
        parsed.password = ''
        return parsed.toString()
      } catch {
        return url
      }
    })
}

const MAX_GIT_REASON_LENGTH = 240

// Lines Git prints as framing rather than explanation. The push header in
// particular precedes the real reason and carries the remote location, so
// taking Git's first stderr line yields the least useful sentence available.
const UNINFORMATIVE_GIT_OUTPUT = [
  /^failed to push some refs\b/i,
  /^See the '[^']*' in 'git [^']*' for details\.?$/i,
  /^Everything up-to-date$/i,
]

/**
 * Reduce Git's stderr to one short redacted sentence a user can act on. Git
 * hard-wraps its explanations across several prefixed lines, so the prefixes
 * are stripped and the remaining text is rejoined before the first sentence is
 * taken.
 */
function gitReason(stderr) {
  const meaningful = []
  for (const rawLine of redactGitText(stderr).split(/\r?\n/)) {
    const text = rawLine.trim().replace(/^(?:fatal|error|warning|hint):\s*/i, '').trim()
    if (!text) continue
    if (UNINFORMATIVE_GIT_OUTPUT.some((pattern) => pattern.test(text))) continue
    meaningful.push(text)
  }
  if (meaningful.length === 0) return ''
  const joined = meaningful.join(' ')
  const sentence = joined.match(/^.*?[.!?](?=\s|$)/)
  const reason = (sentence ? sentence[0] : joined).trim()
  return reason.length > MAX_GIT_REASON_LENGTH
    ? `${reason.slice(0, MAX_GIT_REASON_LENGTH - 1).trimEnd()}\u2026`
    : reason
}

/**
 * A caller-supplied message explains the operation the user asked for, so it
 * leads and Git's own reason follows as supporting detail. Callers whose
 * message already states what Git reported pass `includeGitReason: false` so
 * the plumbing wording is not repeated back to the user.
 */
export function gitFailureMessage(stderr, curated, includeGitReason = true) {
  const reason = gitReason(stderr)
  if (!curated) return reason || 'Git could not complete the operation.'
  if (!includeGitReason || !reason) return curated
  return /[.!?]$/.test(curated) ? `${curated} ${reason}` : `${curated}. ${reason}`
}

export function runGit(args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('Git arguments must be an array of strings.')
  }

  const executable = options.gitExecutable ?? 'git'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS
  const spawnProcess = options.spawn ?? spawn
  if (options.signal?.aborted) {
    return Promise.reject(new GitWorkflowError('Git was stopped before completing.', {
      code: 'git_aborted',
      status: 499,
    }))
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess(executable, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...options.env,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    let stoppingError = null
    let forceTimer = null
    let captureOutput = true
    let timer = null
    const onAbort = () => stopAfterClose(new GitWorkflowError('Git was stopped before completing.', {
      code: 'git_aborted',
      status: 499,
    }))

    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      options.signal?.removeEventListener('abort', onAbort)
      callback()
    }

    const stopAfterClose = (error) => {
      if (stoppingError) return
      stoppingError = error
      captureOutput = false
      clearTimeout(timer)
      try { child.kill('SIGTERM') } catch { /* close/error remains authoritative */ }
      forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* close/error remains authoritative */ }
      }, terminationGraceMs)
    }

    const collect = (target, chunk) => {
      if (!captureOutput) return target
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stopAfterClose(new GitWorkflowError('Git produced too much output.', {
          code: 'git_output_limit',
          status: 502,
        }))
        return target
      }
      return target + chunk.toString('utf8')
    }

    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk) })
    child.on('error', (error) => {
      const workflowError = new GitWorkflowError(
        error && typeof error === 'object' && error.code === 'ENOENT'
        ? 'Git is not installed or is not available on PATH.'
        : 'Ensync Host could not start Git.',
        { code: 'git_unavailable', status: 503 },
      )
      if (!child.pid) finish(() => rejectPromise(workflowError))
      else stopAfterClose(workflowError)
    })
    child.on('close', (exitCode, signal) => finish(() => {
      if (stoppingError) rejectPromise(stoppingError)
      else resolvePromise({
        exitCode: exitCode ?? -1,
        signal,
        stdout,
        stderr,
      })
    }))

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    timer = setTimeout(() => {
      stopAfterClose(new GitWorkflowError('Git timed out without completing.', {
        code: 'git_timeout',
        status: 504,
      }))
    }, timeoutMs)
  })
}

async function checkedGit(args, options = {}) {
  const result = await runGit(args, options)
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new GitWorkflowError(
      gitFailureMessage(result.stderr, options.failureMessage, options.includeGitReason !== false),
      { code: options.code ?? 'git_failed', status: options.status ?? 409 },
    )
  }
  return result
}

export function validateRepositoryLocation(repositoryUrl) {
  if (typeof repositoryUrl !== 'string') {
    throw new GitWorkflowError('Enter a Git repository URL or absolute local repository path.', {
      code: 'invalid_repository',
    })
  }
  const value = repositoryUrl.trim()
  if (!value || value.length > MAX_REPOSITORY_URL_LENGTH || value.startsWith('-') || /[\0\r\n]/.test(value)) {
    throw new GitWorkflowError('Enter a valid Git repository URL or absolute local repository path.', {
      code: 'invalid_repository',
    })
  }

  if (isAbsolute(value)) return value

  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:[^\s]+$/.test(value)) {
    return value
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new GitWorkflowError(
      'Use an http, https, ssh, or git URL, a strict user@host:path SSH URL, or an absolute local path.',
      { code: 'unsupported_repository_location' },
    )
  }
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol.toLowerCase()) || !parsed.hostname) {
    throw new GitWorkflowError(
      'This repository URL type is not supported. External Git remote helpers and relative paths are blocked.',
      { code: 'unsupported_repository_location' },
    )
  }
  if (/\s/.test(value) || parsed.hostname.startsWith('-')) {
    throw new GitWorkflowError('The repository URL is not valid.', { code: 'invalid_repository' })
  }
  if (parsed.password || (['http:', 'https:'].includes(parsed.protocol.toLowerCase()) && parsed.username)) {
    throw new GitWorkflowError(
      'Do not put credentials in the repository URL. Use your existing Git credential helper instead.',
      { code: 'embedded_git_credentials' },
    )
  }
  return value
}

export async function validateCloneDestination(destinationPath, options = {}) {
  if (typeof destinationPath !== 'string' || !isAbsolute(destinationPath)) {
    throw new GitWorkflowError('Clone destination must be an absolute local path.', {
      code: 'invalid_clone_destination',
    })
  }

  const normalized = resolve(destinationPath)
  if (normalized === parse(normalized).root || basename(normalized) === '') {
    throw new GitWorkflowError('The filesystem root cannot be used as a clone destination.', {
      code: 'invalid_clone_destination',
    })
  }

  try {
    await lstat(normalized)
    throw new GitWorkflowError('Clone destination already exists. Choose a new folder path.', {
      code: 'clone_destination_exists',
      status: 409,
    })
  } catch (error) {
    if (error instanceof GitWorkflowError) throw error
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
      throw new GitWorkflowError('Ensync Host could not inspect the clone destination.', {
        code: 'invalid_clone_destination',
      })
    }
  }

  let parent
  try {
    parent = await realpath(dirname(normalized))
    if (!(await stat(parent)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new GitWorkflowError('The clone destination parent folder must already exist.', {
      code: 'invalid_clone_destination',
    })
  }

  const candidate = join(parent, basename(normalized))
  const roots = await canonicalAllowedRoots(options.allowedRoots)
  if (roots && !roots.some((root) => isWithin(root, candidate))) {
    throw new GitWorkflowError('Clone destination is outside the Ensync Host allowed project roots.', {
      code: 'project_not_allowed',
      status: 403,
    })
  }
  return candidate
}

function parseBranchStatus(output) {
  const status = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    dirty: false,
    changedFiles: 0,
  }
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      const branch = line.slice('# branch.head '.length).trim()
      status.detached = branch === '(detached)'
      status.branch = status.detached ? null : branch
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim() || null
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+-(\d+)/)
      if (match) {
        status.ahead = Number(match[1])
        status.behind = Number(match[2])
      }
    } else if (line && !line.startsWith('#')) {
      status.dirty = true
      status.changedFiles += 1
    }
  }
  return status
}

function validateRemoteName(remote) {
  if (typeof remote !== 'string' || !REMOTE_NAME_PATTERN.test(remote)) {
    throw new GitWorkflowError('Select a valid configured Git remote.', { code: 'invalid_git_remote' })
  }
  return remote
}

async function validateConfiguredRemote(repositoryPath, remote, purpose, options = {}) {
  const args = purpose === 'push'
    ? ['remote', 'get-url', '--push', '--all', remote]
    : ['remote', 'get-url', '--all', remote]
  const result = await checkedGit(args, {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    failureMessage: `Git remote ${remote} has no configured ${purpose} URL.`,
    code: 'git_remote_not_found',
  })
  const urls = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  if (urls.length === 0) {
    throw new GitWorkflowError(`Git remote ${remote} has no configured ${purpose} URL.`, {
      code: 'git_remote_not_found',
    })
  }
  try {
    for (const url of urls) validateRepositoryLocation(url)
  } catch (error) {
    if (error instanceof GitWorkflowError) {
      throw new GitWorkflowError(
        `Git remote ${remote} uses an unsupported ${purpose} URL. External remote helpers and relative paths are blocked.`,
        { code: 'unsafe_git_remote', status: 409 },
      )
    }
    throw error
  }
  return urls
}

async function validateBranchName(branch, options = {}) {
  if (typeof branch !== 'string' || !branch.trim() || /[\0\r\n]/.test(branch)) {
    throw new GitWorkflowError('Enter a valid Git branch name.', { code: 'invalid_git_branch' })
  }
  const value = branch.trim()
  const result = await checkedGit(['check-ref-format', '--branch', value], {
    ...options,
    allowFailure: true,
  })
  if (result.exitCode !== 0) {
    throw new GitWorkflowError('Enter a valid Git branch name.', { code: 'invalid_git_branch' })
  }
  return value
}

async function gitRepositoryRoot(projectPath, options = {}) {
  const cwd = await validateProjectPath(projectPath, { allowedRoots: options.allowedRoots })
  const result = await checkedGit(['rev-parse', '--show-toplevel'], {
    cwd,
    gitExecutable: options.gitExecutable,
    failureMessage:
      'The focused project is not inside a Git repository. Open a project inside a repository, or run git init in that folder first.',
    code: 'not_a_git_repository',
    includeGitReason: false,
  })
  const root = result.stdout.trim()
  try {
    return await validateProjectPath(root, { allowedRoots: options.allowedRoots })
  } catch {
    throw new GitWorkflowError('The Git repository root is outside the Ensync Host allowed project roots.', {
      code: 'project_not_allowed',
      status: 403,
    })
  }
}

// Only used when Git has no identity of its own to commit with, so a project
// folder without a configured user still gets its first commit.
const ENSYNC_BASELINE_IDENTITY = {
  GIT_AUTHOR_NAME: 'Ensync',
  GIT_AUTHOR_EMAIL: 'baseline@ensync.local',
  GIT_COMMITTER_NAME: 'Ensync',
  GIT_COMMITTER_EMAIL: 'baseline@ensync.local',
}

// The two checked Git runners in this Host take a curated failure message under
// different names, so a step usable by both supplies each of them.
function baselineFailure(code, message) {
  return { code, message, failureMessage: message, includeGitReason: false }
}

async function baselineCommitIdentity(cwd, run) {
  const [name, email] = await Promise.all([
    run(['config', '--get', 'user.name'], { cwd, allowFailure: true }),
    run(['config', '--get', 'user.email'], { cwd, allowFailure: true }),
  ])
  const configured = name.exitCode === 0 && name.stdout.trim() && email.exitCode === 0 && email.stdout.trim()
  return configured ? undefined : ENSYNC_BASELINE_IDENTITY
}

/**
 * A home directory holds everything a person owns, so it is never the folder
 * Ensync turns into one project repository. An existing repository there is
 * still used as it is; only creating one is refused.
 */
export async function isHomeDirectory(directory, homePath) {
  const home = await realpath(homePath ?? homedir()).catch(() => null)
  return Boolean(home) && resolve(directory) === resolve(home)
}

/**
 * Give a project folder the repository and first commit that isolated agent
 * work needs, and do nothing when it already has them. `run` is the caller's
 * checked Git runner, so this is equally usable from the Host Git service and
 * from project isolation with its injected runner.
 *
 * A folder already inside a repository is left alone: Ensync never nests a new
 * repository inside an existing working tree. When the surrounding repository
 * has no commit yet, the baseline commit is made at its root rather than at the
 * project subdirectory, so a partial tree is never committed into it.
 */
export async function ensureGitRepositoryBaseline(directory, run, options = {}) {
  const existing = await run(['rev-parse', '--show-toplevel'], { cwd: directory, allowFailure: true })
  const initialized = existing.exitCode !== 0
  if (initialized) {
    if (await isHomeDirectory(directory, options.homePath)) {
      return { initialized: false, baselineCommitted: false, repositoryPath: null, refused: 'home_directory' }
    }
    await run(
      ['init', '--initial-branch=main'],
      {
        cwd: directory,
        ...baselineFailure('git_init_failed', 'Git could not create a repository in this project folder.'),
      },
    )
  }

  const located = initialized
    ? await run(['rev-parse', '--show-toplevel'], {
        cwd: directory,
        ...baselineFailure('git_init_failed', 'Git created a repository that it could not then read back.'),
      })
    : existing
  // Git answers with the working-tree root; the project folder is inside it either way.
  const repositoryPath = located.stdout.trim() || directory

  const head = await run(['rev-parse', '--verify', 'HEAD'], { cwd: repositoryPath, allowFailure: true })
  const baselineCommitted = head.exitCode !== 0
  if (baselineCommitted) {
    const env = await baselineCommitIdentity(repositoryPath, run)
    await run(['add', '-A', '--', '.'], {
      cwd: repositoryPath,
      env,
      ...baselineFailure('git_baseline_commit_failed', 'Git could not stage this project for its first commit.'),
    })
    await run(
      ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--allow-empty', '-m', 'Initial commit'],
      {
        cwd: repositoryPath,
        env,
        ...baselineFailure('git_baseline_commit_failed', 'Git could not create the first commit for this project.'),
      },
    )
  }

  return { initialized, baselineCommitted, repositoryPath, refused: null }
}

/**
 * Creates the repository for a focused project that is not inside one yet, then
 * reports the real status of the result. Idempotent: a project that already has
 * a repository and a commit is only inspected.
 */
export async function initializeGitRepository(projectPath, options = {}) {
  const cwd = await validateProjectPath(projectPath, { allowedRoots: options.allowedRoots })
  const outcome = await ensureGitRepositoryBaseline(
    cwd,
    (args, runOptions) => checkedGit(args, {
      ...runOptions,
      gitExecutable: options.gitExecutable,
      timeoutMs: options.initTimeoutMs ?? 120_000,
    }),
    { homePath: options.homePath },
  )
  if (outcome.refused === 'home_directory') {
    throw new GitWorkflowError(
      'A home directory is too broad to become one Ensync project repository. Open the specific project folder instead.',
      { code: 'unsafe_git_init_location', status: 400 },
    )
  }
  const git = await getGitStatus(cwd, options)
  return { initialized: outcome.initialized, baselineCommitted: outcome.baselineCommitted, git }
}

async function remoteDefaultBranch(repositoryPath, remote, options = {}) {
  const symbolic = await checkedGit(
    ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`],
    { cwd: repositoryPath, gitExecutable: options.gitExecutable, allowFailure: true },
  )
  if (symbolic.exitCode === 0) {
    const prefix = `${remote}/`
    const value = symbolic.stdout.trim()
    if (value.startsWith(prefix)) return value.slice(prefix.length)
  }

  for (const candidate of ['main', 'master']) {
    const found = await checkedGit(
      ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${candidate}`],
      { cwd: repositoryPath, gitExecutable: options.gitExecutable, allowFailure: true },
    )
    if (found.exitCode === 0) return candidate
  }
  return null
}

export async function getGitStatus(projectPath, options = {}) {
  const repositoryPath = await gitRepositoryRoot(projectPath, options)
  const branchResult = await checkedGit(['status', '--porcelain=v2', '--branch'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
  })
  const branchStatus = parseBranchStatus(branchResult.stdout)
  const remoteResult = await checkedGit(['remote'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
  })
  const names = remoteResult.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  const remotes = []
  for (const name of names) {
    const fetchUrls = await checkedGit(['remote', 'get-url', '--all', name], {
      cwd: repositoryPath,
      gitExecutable: options.gitExecutable,
      allowFailure: true,
    })
    const pushUrls = await checkedGit(['remote', 'get-url', '--push', '--all', name], {
      cwd: repositoryPath,
      gitExecutable: options.gitExecutable,
      allowFailure: true,
    })
    remotes.push({
      name,
      fetchUrls: fetchUrls.stdout.split(/\r?\n/).map((item) => redactGitText(item.trim())).filter(Boolean),
      pushUrls: pushUrls.stdout.split(/\r?\n/).map((item) => redactGitText(item.trim())).filter(Boolean),
    })
  }

  const preferredRemote = names.includes('origin') ? 'origin' : (names[0] ?? null)
  const productionBranch = preferredRemote
    ? await remoteDefaultBranch(repositoryPath, preferredRemote, options)
    : null

  return {
    repositoryPath,
    ...branchStatus,
    remotes,
    preferredRemote,
    productionBranch,
    productionBranchSource: productionBranch ? 'remote' : 'unavailable',
    checkedAt: new Date().toISOString(),
  }
}

export async function cloneGitRepository(input, options = {}) {
  const repositoryUrl = validateRepositoryLocation(input?.repositoryUrl)
  const destinationPath = await validateCloneDestination(input?.destinationPath, options)

  await checkedGit(['clone', '--', repositoryUrl, destinationPath], {
    gitExecutable: options.gitExecutable,
    timeoutMs: options.timeoutMs ?? 120_000,
    failureMessage: 'Git could not clone the repository. Check the URL and your existing Git credentials.',
    code: 'git_clone_failed',
  })

  const canonicalDestination = await realpath(destinationPath)
  const [project, git] = await Promise.all([
    inspectProject(canonicalDestination, { allowedRoots: options.allowedRoots }),
    getGitStatus(canonicalDestination, options),
  ])
  return { project, git }
}

export async function verifyGitRemote(input, options = {}) {
  const status = await getGitStatus(input?.projectPath, options)
  const remote = validateRemoteName(input?.remote ?? status.preferredRemote ?? '')
  if (!status.remotes.some((item) => item.name === remote)) {
    throw new GitWorkflowError(`Git remote ${remote} is not configured for this project.`, {
      code: 'git_remote_not_found',
    })
  }
  await validateConfiguredRemote(status.repositoryPath, remote, 'fetch', options)
  const result = await checkedGit(['ls-remote', '--symref', '--exit-code', remote, 'HEAD'], {
    cwd: status.repositoryPath,
    gitExecutable: options.gitExecutable,
    timeoutMs: options.timeoutMs ?? 30_000,
    failureMessage: 'Git could not reach the remote with the credentials already configured on this computer.',
    code: 'git_connection_failed',
  })
  const match = result.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m)
  return {
    remote,
    connected: true,
    defaultBranch: match?.[1] ?? null,
    authentication: 'existing_git_credentials',
    message: 'Git reached the remote using the credentials or SSH agent already configured on this computer.',
    checkedAt: new Date().toISOString(),
  }
}

export async function pushGit(input, options = {}) {
  const status = await getGitStatus(input?.projectPath, options)
  if (!status.branch || status.detached) {
    throw new GitWorkflowError('Check out a branch before pushing.', { code: 'git_detached_head' })
  }
  const remote = validateRemoteName(input?.remote ?? status.preferredRemote ?? '')
  if (!status.remotes.some((item) => item.name === remote)) {
    throw new GitWorkflowError(`Git remote ${remote} is not configured for this project.`, {
      code: 'git_remote_not_found',
    })
  }
  await validateConfiguredRemote(status.repositoryPath, remote, 'push', options)

  const mode = input?.mode === 'production' ? 'production' : 'current_branch'
  let targetBranch = status.branch
  if (mode === 'production') {
    targetBranch = await validateBranchName(input?.productionBranch ?? status.productionBranch ?? '', {
      gitExecutable: options.gitExecutable,
    })
    const expectedConfirmation = `PUSH TO ${targetBranch}`
    if (input?.allowProduction !== true || input?.confirmation !== expectedConfirmation) {
      throw new GitWorkflowError(
        `Direct production push requires the exact confirmation: ${expectedConfirmation}`,
        { code: 'production_confirmation_required', status: 409 },
      )
    }
  } else {
    if (status.productionBranch && status.branch === status.productionBranch) {
      throw new GitWorkflowError(
        `Safe branch push will not push the discovered production branch ${status.productionBranch}. Switch to a feature branch or use direct production push with confirmation.`,
        { code: 'production_confirmation_required', status: 409 },
      )
    }
    targetBranch = await validateBranchName(targetBranch, { gitExecutable: options.gitExecutable })
  }

  await checkedGit(
    mode === 'current_branch'
      ? ['push', '--porcelain', '--set-upstream', remote, `HEAD:refs/heads/${targetBranch}`]
      : ['push', '--porcelain', remote, `HEAD:refs/heads/${targetBranch}`],
    {
      cwd: status.repositoryPath,
      gitExecutable: options.gitExecutable,
      timeoutMs: options.timeoutMs ?? 120_000,
      failureMessage: `Git could not push to ${remote}/${targetBranch}.`,
      code: 'git_push_failed',
    },
  )

  return {
    push: {
      mode,
      remote,
      sourceBranch: status.branch,
      targetBranch,
      completedAt: new Date().toISOString(),
    },
    git: await getGitStatus(status.repositoryPath, options),
  }
}

const AGENT_BRANCH_PATTERN = /^ensync\/chat-[a-f0-9]{24}$/

async function baselineBranch(repositoryPath, options) {
  const symbolic = await checkedGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    allowFailure: true,
  })
  return symbolic.exitCode === 0 ? symbolic.stdout.trim() : null
}

export async function listUnlandedAgentWork(projectPath, options = {}) {
  const repositoryPath = await gitRepositoryRoot(projectPath, options)
  const head = await checkedGit(['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    code: 'git_baseline_unavailable',
    failureMessage: 'The repository needs an initial commit before unlanded agent work can be listed.',
  })
  const branch = await baselineBranch(repositoryPath, options)
  const refs = await checkedGit(
    ['for-each-ref', 'refs/heads/ensync/chat-*', '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso8601-strict)%00%(contents:subject)'],
    { cwd: repositoryPath, gitExecutable: options.gitExecutable },
  )
  const branches = []
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, objectName, committedAt, subject] = line.split('\0')
    const ahead = await checkedGit(['rev-list', '--count', `HEAD..${name}`], {
      cwd: repositoryPath,
      gitExecutable: options.gitExecutable,
    })
    const aheadCount = Number.parseInt(ahead.stdout.trim(), 10) || 0
    if (aheadCount === 0) continue
    const diff = await checkedGit(['diff', '--name-only', `HEAD...${name}`], {
      cwd: repositoryPath,
      gitExecutable: options.gitExecutable,
    })
    branches.push({
      branch: name,
      head: objectName,
      aheadCount,
      changedFiles: diff.stdout.split(/\r?\n/).filter(Boolean).length,
      lastCommittedAt: committedAt || null,
      lastSubject: subject || null,
    })
  }
  return {
    repositoryPath,
    baseline: { branch, head: head.stdout.trim() },
    branches,
    checkedAt: new Date().toISOString(),
  }
}

function worktreePathForBranch(value, branch) {
  let path = null
  for (const line of String(value ?? '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    if (line === `branch refs/heads/${branch}`) return path
    if (!line) path = null
  }
  return null
}

function providerFromCommitMessage(value) {
  const provider = String(value ?? '').match(/^Provider:\s*([a-z0-9._-]+)\s*$/im)?.[1]?.toLowerCase()
  return provider || 'codex'
}

export async function captureLandingTarget(repositoryPath, options = {}) {
  const invoke = options.checkedGit ?? checkedGit
  const commandOptions = {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    code: 'landing_target_unavailable',
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await invoke(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      ...commandOptions,
      failureMessage: 'Check out the branch this saved conversation should land into.',
    })
    const targetBranch = before.stdout.trim()
    const targetBase = await invoke([
      'rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`,
    ], commandOptions)
    const after = await invoke(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      ...commandOptions,
      failureMessage: 'Check out the branch this saved conversation should land into.',
    })
    if (after.stdout.trim() === targetBranch) {
      return { targetBranch, targetBaseSha: targetBase.stdout.trim() }
    }
  }
  throw new GitWorkflowError('The checked-out branch changed while Ensync captured the automatic landing target. Retry after the checkout is stable.', {
    code: 'landing_target_changed',
    status: 409,
  })
}

/**
 * Compatibility path for the old explicit Land button. It snapshots the exact
 * branch SHA into the same event-driven landing queue used at chat completion;
 * no merge, lock, verification wait, or checkout mutation happens here.
 */
export async function queueAgentBranchLanding(input, options = {}) {
  const branch = typeof input?.branch === 'string' ? input.branch : ''
  if (!AGENT_BRANCH_PATTERN.test(branch)) {
    throw new GitWorkflowError('Only Ensync agent conversation branches (ensync/chat-…) can be queued.', {
      code: 'invalid_agent_branch',
      status: 400,
    })
  }
  if (!options.landingCoordinator || typeof options.landingCoordinator.enqueue !== 'function') {
    throw new GitWorkflowError('Automatic landing is unavailable.', {
      code: 'automatic_landing_unavailable',
      status: 503,
    })
  }
  const projectPath = await validateProjectPath(input.projectPath, { allowedRoots: options.allowedRoots })
  const repositoryPath = await gitRepositoryRoot(input.projectPath, options)
  const saved = await checkedGit(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    code: 'invalid_agent_branch',
    status: 400,
    failureMessage: `The agent branch ${branch} does not exist in this repository.`,
  })
  const savedSha = saved.stdout.trim()
  const [worktrees, commit, commonGitResult] = await Promise.all([
    checkedGit(['worktree', 'list', '--porcelain'], {
      cwd: repositoryPath,
      gitExecutable: options.gitExecutable,
    }),
    checkedGit(['show', '-s', '--format=%B', savedSha], {
      cwd: repositoryPath,
      gitExecutable: options.gitExecutable,
    }),
    checkedGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repositoryPath,
      gitExecutable: options.gitExecutable,
      code: 'landing_target_unavailable',
      failureMessage: 'Ensync could not identify the repository shared Git directory.',
    }),
  ])
  const target = await captureLandingTarget(repositoryPath, options)
  const commonValue = commonGitResult.stdout.trim()
  const commonGitDirectory = await realpath(
    isAbsolute(commonValue) ? commonValue : resolve(repositoryPath, commonValue),
  )
  const item = await options.landingCoordinator.enqueue({
    repositoryPath,
    commonGitDirectory,
    projectPath,
    workspacePath: worktreePathForBranch(worktrees.stdout, branch) ?? repositoryPath,
    branch,
    savedSha,
    targetBranch: target.targetBranch,
    targetBaseSha: target.targetBaseSha,
    provider: providerFromCommitMessage(commit.stdout),
  })
  return {
    land: {
      disposition: 'queued',
      branch,
      savedSha,
      completionSequence: item.completionSequence ?? null,
      queuedAt: item.createdAt ?? new Date().toISOString(),
    },
  }
}

export class GitWorkflowService {
  constructor(options = {}) {
    this.allowedRoots = options.allowedRoots
    this.gitExecutable = options.gitExecutable
    this.landingCoordinator = options.landingCoordinator
  }

  options() {
    return {
      allowedRoots: this.allowedRoots,
      gitExecutable: this.gitExecutable,
      landingCoordinator: this.landingCoordinator,
    }
  }

  status(projectPath) {
    return getGitStatus(projectPath, this.options())
  }

  initialize(projectPath) {
    return initializeGitRepository(projectPath, this.options())
  }

  clone(input) {
    return cloneGitRepository(input, this.options())
  }

  verifyRemote(input) {
    return verifyGitRemote(input, this.options())
  }

  push(input) {
    return pushGit(input, this.options())
  }

  unlanded(projectPath) {
    return listUnlandedAgentWork(projectPath, this.options())
  }

  land(input) {
    return queueAgentBranchLanding(input, this.options())
  }
}

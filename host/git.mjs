import { spawn } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { inspectProject } from './projects.mjs'
import { validateProjectPath } from './chat.mjs'

const DEFAULT_TIMEOUT_MS = 30_000
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

function gitFailureMessage(stderr, fallback) {
  const line = redactGitText(stderr)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean)
  return line || fallback
}

export function runGit(args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('Git arguments must be an array of strings.')
  }

  const executable = options.gitExecutable ?? 'git'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
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

    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }

    const collect = (target, chunk) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill()
        finish(() => rejectPromise(new GitWorkflowError('Git produced too much output.', {
          code: 'git_output_limit',
          status: 502,
        })))
        return target
      }
      return target + chunk.toString('utf8')
    }

    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk) })
    child.on('error', (error) => finish(() => rejectPromise(new GitWorkflowError(
      error && typeof error === 'object' && error.code === 'ENOENT'
        ? 'Git is not installed or is not available on PATH.'
        : 'Ensync Host could not start Git.',
      { code: 'git_unavailable', status: 503 },
    ))))
    child.on('close', (exitCode, signal) => finish(() => resolvePromise({
      exitCode: exitCode ?? -1,
      signal,
      stdout,
      stderr,
    })))

    const timer = setTimeout(() => {
      child.kill()
      finish(() => rejectPromise(new GitWorkflowError('Git timed out without completing.', {
        code: 'git_timeout',
        status: 504,
      })))
    }, timeoutMs)
  })
}

async function checkedGit(args, options = {}) {
  const result = await runGit(args, options)
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new GitWorkflowError(
      gitFailureMessage(result.stderr, options.failureMessage ?? 'Git could not complete the operation.'),
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
    failureMessage: 'The focused project is not inside a Git repository.',
    code: 'not_a_git_repository',
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
const LAND_MESSAGE_PREFIX = 'Ensync land: '

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

export async function landAgentBranch(input, options = {}) {
  const branch = typeof input?.branch === 'string' ? input.branch : ''
  if (!AGENT_BRANCH_PATTERN.test(branch)) {
    throw new GitWorkflowError('Only Ensync agent conversation branches (ensync/chat-…) can be landed.', {
      code: 'invalid_agent_branch',
      status: 400,
    })
  }
  const repositoryPath = await gitRepositoryRoot(input.projectPath, options)
  await checkedGit(['show-ref', '--verify', `refs/heads/${branch}`], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    code: 'invalid_agent_branch',
    status: 400,
    failureMessage: `The agent branch ${branch} does not exist in this repository.`,
  })
  const mergedInto = await baselineBranch(repositoryPath, options)
  if (!mergedInto) {
    throw new GitWorkflowError('The shared checkout is on a detached HEAD; check out a branch before landing agent work.', {
      code: 'git_detached_head',
      status: 409,
    })
  }
  const status = await checkedGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
  })
  const dirtyCount = status.stdout.split('\0').filter(Boolean).length
  if (dirtyCount > 0) {
    throw new GitWorkflowError(
      `The shared checkout has ${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}. Commit or stash your work before landing agent changes.`,
      { code: 'shared_checkout_dirty', status: 409 },
    )
  }
  const ahead = await checkedGit(['rev-list', '--count', `HEAD..${branch}`], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
  })
  if ((Number.parseInt(ahead.stdout.trim(), 10) || 0) === 0) {
    throw new GitWorkflowError(`${branch} has no commits that are not already on ${mergedInto}.`, {
      code: 'agent_branch_already_landed',
      status: 409,
    })
  }
  const check = await checkedGit(['merge-tree', '--write-tree', '--name-only', 'HEAD', branch], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    allowFailure: true,
  })
  if (check.exitCode !== 0 && check.exitCode !== 1) {
    throw new GitWorkflowError(
      'This Git version does not support conflict pre-checks (git 2.38+ is required for landing).',
      { code: 'git_merge_tree_unsupported', status: 409 },
    )
  }
  if (check.exitCode === 1) {
    // Conflicted output: <tree-oid>\n<conflicted files…>\n\n<informational messages>
    const rawLines = check.stdout.split(/\r?\n/)
    const blankIndex = rawLines.indexOf('', 1)
    const files = rawLines.slice(1, blankIndex === -1 ? undefined : blankIndex).filter(Boolean)
    const conflictError = new GitWorkflowError(
      `Landing ${branch} would conflict in: ${files.join(', ') || 'unknown files'}. Continue that conversation so it syncs with ${mergedInto} and resolves the conflict in its own worktree, then land.`,
      { code: 'agent_branch_conflicts', status: 409 },
    )
    conflictError.files = files
    throw conflictError
  }
  const merge = await checkedGit(
    ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', `${LAND_MESSAGE_PREFIX}${branch}`, branch],
    { cwd: repositoryPath, gitExecutable: options.gitExecutable, allowFailure: true },
  )
  if (merge.exitCode !== 0) {
    await checkedGit(['merge', '--abort'], { cwd: repositoryPath, gitExecutable: options.gitExecutable, allowFailure: true })
    throw new GitWorkflowError(gitFailureMessage(merge.stderr, `Git could not land ${branch}.`), {
      code: 'agent_branch_land_failed',
      status: 409,
    })
  }
  if (typeof options.verifyLand === 'function') {
    // A textually clean merge can still drop code one side depends on, so the
    // land is verified semantically after the merge commit exists. A failed
    // verification rolls the checkout back to its pre-merge state exactly; the
    // checkout was verified clean above, so the reset cannot destroy user work.
    let verification
    try {
      verification = await options.verifyLand({ repositoryPath, branch, mergedInto })
    } catch (error) {
      verification = { ok: false, reason: error instanceof Error ? error.message : 'The land verification could not run.' }
    }
    if (verification && verification.ok === false) {
      await checkedGit(['reset', '--hard', 'ORIG_HEAD'], {
        cwd: repositoryPath,
        gitExecutable: options.gitExecutable,
      })
      const verificationError = new GitWorkflowError(
        `Landing ${branch} was rolled back because the land verification failed: ${verification.reason ?? 'no reason was reported'}`,
        { code: 'agent_branch_verification_failed', status: 409 },
      )
      verificationError.verification = verification
      throw verificationError
    }
  }
  const mergeHead = await checkedGit(['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
  })
  return {
    land: {
      branch,
      mergedInto,
      mergeHead: mergeHead.stdout.trim(),
      completedAt: new Date().toISOString(),
    },
    git: await getGitStatus(input.projectPath, options),
  }
}

export class GitWorkflowService {
  constructor(options = {}) {
    this.allowedRoots = options.allowedRoots
    this.gitExecutable = options.gitExecutable
    this.verifyLand = options.verifyLand
  }

  options() {
    return { allowedRoots: this.allowedRoots, gitExecutable: this.gitExecutable, verifyLand: this.verifyLand }
  }

  status(projectPath) {
    return getGitStatus(projectPath, this.options())
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
    return landAgentBranch(input, this.options())
  }
}

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  cloneGitRepository,
  getGitStatus,
  GitWorkflowError,
  initializeGitRepository,
  listUnlandedAgentWork,
  pushGit,
  queueAgentBranchLanding,
  verifyGitRemote,
} from './git.mjs'

const execFileAsync = promisify(execFile)

async function git(args, options = {}) {
  return execFileAsync('git', args, {
    cwd: options.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 512 * 1024,
  })
}

async function gitFixture(context) {
  try {
    await git(['--version'])
  } catch {
    context.skip('Git is not installed on this test host.')
    return null
  }

  const root = await mkdtemp(join(tmpdir(), 'relay-git-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const seed = join(root, 'seed')
  const remote = join(root, 'remote.git')
  const clone = join(root, 'clone')
  await mkdir(seed)
  await git(['init', '-b', 'main'], { cwd: seed })
  await git(['config', 'user.name', 'Relay Test'], { cwd: seed })
  await git(['config', 'user.email', 'relay-test@example.invalid'], { cwd: seed })
  await writeFile(join(seed, 'README.md'), '# Local fixture\n')
  await git(['add', 'README.md'], { cwd: seed })
  await git(['commit', '-m', 'Initial commit'], { cwd: seed })
  await git(['init', '--bare', remote])
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remote })
  await git(['remote', 'add', 'origin', remote], { cwd: seed })
  await git(['push', '--set-upstream', 'origin', 'main'], { cwd: seed })
  return { root, seed, remote, clone }
}

test('clone, status, remote verification, safe branch push, and confirmed production push use a local bare remote', async (context) => {
  const fixture = await gitFixture(context)
  if (!fixture) return

  const cloned = await cloneGitRepository({
    repositoryUrl: fixture.remote,
    destinationPath: fixture.clone,
  }, { allowedRoots: [fixture.root] })
  assert.equal(cloned.project.path, await realpath(fixture.clone))
  assert.equal(cloned.git.branch, 'main')
  assert.equal(cloned.git.productionBranch, 'main')
  assert.equal(cloned.git.preferredRemote, 'origin')
  assert.equal(cloned.git.dirty, false)

  await writeFile(join(fixture.clone, 'uncommitted.txt'), 'not committed\n')
  const dirty = await getGitStatus(fixture.clone, { allowedRoots: [fixture.root] })
  assert.equal(dirty.dirty, true)
  assert.equal(dirty.changedFiles, 1)
  await rm(join(fixture.clone, 'uncommitted.txt'))

  const connection = await verifyGitRemote({ projectPath: fixture.clone, remote: 'origin' }, {
    allowedRoots: [fixture.root],
  })
  assert.equal(connection.connected, true)
  assert.equal(connection.defaultBranch, 'main')
  assert.equal(connection.authentication, 'existing_git_credentials')

  await assert.rejects(
    pushGit({ projectPath: fixture.clone, remote: 'origin', mode: 'current_branch' }, {
      allowedRoots: [fixture.root],
    }),
    (error) => error instanceof GitWorkflowError
      && error.code === 'production_confirmation_required'
      && /feature branch/.test(error.message),
  )

  await git(['config', 'user.name', 'Relay Test'], { cwd: fixture.clone })
  await git(['config', 'user.email', 'relay-test@example.invalid'], { cwd: fixture.clone })
  await git(['checkout', '-b', 'feature/relay-git'], { cwd: fixture.clone })
  await writeFile(join(fixture.clone, 'feature.txt'), 'feature commit\n')
  await git(['add', 'feature.txt'], { cwd: fixture.clone })
  await git(['commit', '-m', 'Feature commit'], { cwd: fixture.clone })

  const branchPush = await pushGit({
    projectPath: fixture.clone,
    remote: 'origin',
    mode: 'current_branch',
  }, { allowedRoots: [fixture.root] })
  assert.deepEqual(branchPush.push, {
    mode: 'current_branch',
    remote: 'origin',
    sourceBranch: 'feature/relay-git',
    targetBranch: 'feature/relay-git',
    completedAt: branchPush.push.completedAt,
  })
  await git(['show-ref', '--verify', 'refs/heads/feature/relay-git'], { cwd: fixture.remote })

  await assert.rejects(
    pushGit({
      projectPath: fixture.clone,
      remote: 'origin',
      mode: 'production',
      productionBranch: 'main',
      allowProduction: true,
      confirmation: 'main',
    }, { allowedRoots: [fixture.root] }),
    (error) => error instanceof GitWorkflowError && error.code === 'production_confirmation_required',
  )

  const productionPush = await pushGit({
    projectPath: fixture.clone,
    remote: 'origin',
    mode: 'production',
    productionBranch: 'main',
    allowProduction: true,
    confirmation: 'PUSH TO main',
  }, { allowedRoots: [fixture.root] })
  assert.equal(productionPush.push.sourceBranch, 'feature/relay-git')
  assert.equal(productionPush.push.targetBranch, 'main')
  const featureHead = (await git(['rev-parse', 'HEAD'], { cwd: fixture.clone })).stdout.trim()
  const productionHead = (await git(['rev-parse', 'refs/heads/main'], { cwd: fixture.remote })).stdout.trim()
  assert.equal(productionHead, featureHead)
})

test('clone rejects relative paths and external Git remote helpers before Git is spawned', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-git-location-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))

  for (const repositoryUrl of ['relative/repository.git', 'ext::sh -c dangerous', 'file:///tmp/repository.git']) {
    await assert.rejects(
      cloneGitRepository({ repositoryUrl, destinationPath: join(root, `clone-${Math.random()}`) }, {
        allowedRoots: [root],
        gitExecutable: join(root, 'git-must-not-run'),
      }),
      (error) => error instanceof GitWorkflowError && error.code === 'unsupported_repository_location',
    )
  }
})

test('verify and push reject a configured external-helper remote before contacting it', async (context) => {
  const fixture = await gitFixture(context)
  if (!fixture) return
  const unsafeRepository = join(fixture.root, 'unsafe')
  await mkdir(unsafeRepository)
  await git(['init', '-b', 'feature/safe'], { cwd: unsafeRepository })
  await git(['config', 'user.name', 'Relay Test'], { cwd: unsafeRepository })
  await git(['config', 'user.email', 'relay-test@example.invalid'], { cwd: unsafeRepository })
  await writeFile(join(unsafeRepository, 'README.md'), '# Unsafe remote fixture\n')
  await git(['add', 'README.md'], { cwd: unsafeRepository })
  await git(['commit', '-m', 'Initial commit'], { cwd: unsafeRepository })
  await git(['remote', 'add', 'origin', 'ext::relay-malicious-helper'], { cwd: unsafeRepository })

  await assert.rejects(
    verifyGitRemote({ projectPath: unsafeRepository, remote: 'origin' }, {
      allowedRoots: [fixture.root],
    }),
    (error) => error instanceof GitWorkflowError && error.code === 'unsafe_git_remote',
  )
  await assert.rejects(
    pushGit({ projectPath: unsafeRepository, remote: 'origin', mode: 'current_branch' }, {
      allowedRoots: [fixture.root],
    }),
    (error) => error instanceof GitWorkflowError && error.code === 'unsafe_git_remote',
  )
})

async function agentBranchFixture(context) {
  const fixture = await gitFixture(context)
  if (!fixture) return null
  await git(['branch', 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa'], { cwd: fixture.seed })
  await git(['checkout', 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa'], { cwd: fixture.seed })
  await writeFile(join(fixture.seed, 'agent-feature.txt'), 'built by a chat\n')
  await git(['add', 'agent-feature.txt'], { cwd: fixture.seed })
  await git(['commit', '-m', 'Ensync agent work (succeeded)'], { cwd: fixture.seed })
  await git(['checkout', 'main'], { cwd: fixture.seed })
  return fixture
}

test('listUnlandedAgentWork reports agent branches ahead of the baseline', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  const result = await listUnlandedAgentWork(fixture.seed, { allowedRoots: [fixture.root] })
  assert.equal(result.baseline.branch, 'main')
  assert.equal(result.branches.length, 1)
  const [entry] = result.branches
  assert.equal(entry.branch, 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(entry.aheadCount, 1)
  assert.equal(entry.changedFiles, 1)
  assert.equal(entry.lastSubject, 'Ensync agent work (succeeded)')
})

test('explicit land snapshots the exact branch SHA into the immediate queue without mutating the checkout', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  const queued = []
  const headBefore = (await git(['rev-parse', 'HEAD'], { cwd: fixture.seed })).stdout.trim()

  const result = await queueAgentBranchLanding(
    { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
    {
      allowedRoots: [fixture.root],
      landingCoordinator: {
        async enqueue(item) {
          queued.push(item)
          return { ...item, completionSequence: 7, createdAt: '2026-09-03T00:00:00.000Z' }
        },
      },
    },
  )

  assert.equal(result.land.disposition, 'queued')
  assert.equal(result.land.completionSequence, 7)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].branch, 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.match(queued[0].savedSha, /^[a-f0-9]{40}$/)
  assert.equal(queued[0].savedSha, result.land.savedSha)
  assert.equal(queued[0].provider, 'codex')
  assert.equal(queued[0].repositoryPath, await realpath(fixture.seed))
  assert.equal((await git(['rev-parse', 'HEAD'], { cwd: fixture.seed })).stdout.trim(), headBefore)
  await assert.rejects(stat(join(fixture.seed, '.git', 'ensync', 'repository-land.lock')))
})

test('explicit land rejects non-conversation branches and an unavailable coordinator', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return

  await assert.rejects(
    queueAgentBranchLanding(
      { projectPath: fixture.seed, branch: 'main' },
      { allowedRoots: [fixture.root], landingCoordinator: { enqueue() {} } },
    ),
    (error) => error instanceof GitWorkflowError && error.code === 'invalid_agent_branch',
  )
  await assert.rejects(
    queueAgentBranchLanding(
      { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
      { allowedRoots: [fixture.root] },
    ),
    (error) => error instanceof GitWorkflowError && error.code === 'automatic_landing_unavailable',
  )
})

test('a project outside a repository reports the explanation instead of raw Git plumbing output', async (context) => {
  const fixture = await gitFixture(context)
  if (!fixture) return
  const plain = join(fixture.root, 'plain-folder')
  await mkdir(plain)

  const error = await getGitStatus(plain, { allowedRoots: [fixture.root] }).then(
    () => null,
    (thrown) => thrown,
  )

  assert.ok(error instanceof GitWorkflowError)
  assert.equal(error.code, 'not_a_git_repository')
  assert.match(error.message, /not inside a Git repository/)
  assert.doesNotMatch(error.message, /fatal:/i)
  assert.doesNotMatch(error.message, /any of the parent directories/i)
})

test('a failed push leads with the explanation and keeps the reason Git reported', async (context) => {
  const fixture = await gitFixture(context)
  if (!fixture) return
  await git(['checkout', '-b', 'feature'], { cwd: fixture.seed })
  await writeFile(join(fixture.seed, 'feature.txt'), 'first\n')
  await git(['add', 'feature.txt'], { cwd: fixture.seed })
  await git(['commit', '-m', 'Feature commit'], { cwd: fixture.seed })
  await git(['push', '--set-upstream', 'origin', 'feature'], { cwd: fixture.seed })

  await git(['clone', fixture.remote, fixture.clone])
  await git(['config', 'user.name', 'Relay Other'], { cwd: fixture.clone })
  await git(['config', 'user.email', 'relay-other@example.invalid'], { cwd: fixture.clone })
  await git(['checkout', 'feature'], { cwd: fixture.clone })
  await writeFile(join(fixture.clone, 'other.txt'), 'concurrent\n')
  await git(['add', 'other.txt'], { cwd: fixture.clone })
  await git(['commit', '-m', 'Concurrent commit'], { cwd: fixture.clone })
  await git(['push', 'origin', 'feature'], { cwd: fixture.clone })

  await writeFile(join(fixture.seed, 'feature.txt'), 'second\n')
  await git(['add', 'feature.txt'], { cwd: fixture.seed })
  await git(['commit', '-m', 'Diverged commit'], { cwd: fixture.seed })

  const error = await pushGit(
    { projectPath: fixture.seed, remote: 'origin', mode: 'current_branch' },
    { allowedRoots: [fixture.root] },
  ).then(() => null, (thrown) => thrown)

  assert.ok(error instanceof GitWorkflowError)
  assert.equal(error.code, 'git_push_failed')
  assert.ok(
    error.message.startsWith('Git could not push to origin/feature.'),
    `expected the explanation to lead, got: ${error.message}`,
  )
  assert.match(error.message, /reject|fast-forward|fetch first/i)
})

test('initializing a plain project folder creates a repository whose baseline commit holds the existing files', async (context) => {
  const fixture = await gitFixture(context)
  if (!fixture) return
  const plain = join(fixture.root, 'plain-project')
  await mkdir(plain)
  await writeFile(join(plain, 'notes.md'), '# Notes\n')

  const created = await initializeGitRepository(plain, { allowedRoots: [fixture.root] })

  assert.equal(created.initialized, true)
  assert.equal(created.baselineCommitted, true)
  assert.equal(created.git.repositoryPath, await realpath(plain))
  assert.equal(created.git.branch, 'main')
  assert.equal(created.git.dirty, false)
  assert.equal((await git(['ls-files'], { cwd: plain })).stdout.trim(), 'notes.md')

  // Initializing an already-initialized project changes nothing.
  const again = await initializeGitRepository(plain, { allowedRoots: [fixture.root] })
  assert.equal(again.initialized, false)
  assert.equal(again.baselineCommitted, false)
  assert.equal((await git(['rev-list', '--count', 'HEAD'], { cwd: plain })).stdout.trim(), '1')
})

test('a repository that has no commit yet gets the baseline commit isolated work needs', async (context) => {
  const fixture = await gitFixture(context)
  if (!fixture) return
  const unborn = join(fixture.root, 'unborn')
  await mkdir(unborn)
  await git(['init', '--initial-branch=main'], { cwd: unborn })
  await writeFile(join(unborn, 'app.txt'), 'hello\n')

  const result = await initializeGitRepository(unborn, { allowedRoots: [fixture.root] })

  assert.equal(result.initialized, false)
  assert.equal(result.baselineCommitted, true)
  assert.equal((await git(['show', 'HEAD:app.txt'], { cwd: unborn })).stdout.trim(), 'hello')
})

test('a folder inside an existing repository is never turned into a nested repository', async (context) => {
  const fixture = await gitFixture(context)
  if (!fixture) return
  const nested = join(fixture.seed, 'packages', 'app')
  await mkdir(nested, { recursive: true })

  const result = await initializeGitRepository(nested, { allowedRoots: [fixture.root] })

  assert.equal(result.initialized, false)
  assert.equal(result.baselineCommitted, false)
  assert.equal(result.git.repositoryPath, await realpath(fixture.seed))
  await assert.rejects(stat(join(nested, '.git')), { code: 'ENOENT' })
})

test('the home directory is refused as a project to initialize', async (context) => {
  const fixture = await gitFixture(context)
  if (!fixture) return

  const error = await initializeGitRepository(fixture.root, {
    allowedRoots: [fixture.root],
    homePath: fixture.root,
  }).then(() => null, (thrown) => thrown)

  assert.ok(error instanceof GitWorkflowError)
  assert.equal(error.code, 'unsafe_git_init_location')
  await assert.rejects(stat(join(fixture.root, '.git')), { code: 'ENOENT' })
})

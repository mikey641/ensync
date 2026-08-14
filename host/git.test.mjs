import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  cloneGitRepository,
  getGitStatus,
  GitWorkflowError,
  landAgentBranch,
  listUnlandedAgentWork,
  pushGit,
  pushLandedBaseline,
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

test('landAgentBranch merges a clean agent branch into the baseline with a non-force merge commit', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  const result = await landAgentBranch(
    { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
    { allowedRoots: [fixture.root] },
  )
  assert.equal(result.land.branch, 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(result.land.mergedInto, 'main')
  const subject = (await git(['log', '-1', '--format=%s'], { cwd: fixture.seed })).stdout.trim()
  assert.equal(subject, 'Ensync land: ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
  const landedFile = (await git(['show', 'HEAD:agent-feature.txt'], { cwd: fixture.seed })).stdout
  assert.equal(landedFile, 'built by a chat\n')
  // Branch survives landing and is now fully merged.
  await git(['show-ref', '--verify', 'refs/heads/ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa'], { cwd: fixture.seed })
  const after = await listUnlandedAgentWork(fixture.seed, { allowedRoots: [fixture.root] })
  assert.equal(after.branches.length, 0)
})

test('simultaneous agent lands serialize through verification and recheck the new HEAD', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  const secondBranch = 'ensync/chat-bbbbbbbbbbbbbbbbbbbbbbbb'
  await git(['branch', secondBranch], { cwd: fixture.seed })
  await git(['checkout', secondBranch], { cwd: fixture.seed })
  await writeFile(join(fixture.seed, 'second-feature.txt'), 'built by another chat\n')
  await git(['add', 'second-feature.txt'], { cwd: fixture.seed })
  await git(['commit', '-m', 'Second Ensync agent work'], { cwd: fixture.seed })
  await git(['checkout', 'main'], { cwd: fixture.seed })

  let activeVerifications = 0
  let maximumActiveVerifications = 0
  let releaseFirst
  const firstVerification = new Promise((resolve) => { releaseFirst = resolve })
  let firstEntered
  const firstStartedVerification = new Promise((resolve) => { firstEntered = resolve })
  const verifyLand = async ({ branch }) => {
    activeVerifications += 1
    maximumActiveVerifications = Math.max(maximumActiveVerifications, activeVerifications)
    if (branch === 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa') {
      firstEntered()
      await firstVerification
    }
    activeVerifications -= 1
    return { ok: true }
  }
  const options = {
    allowedRoots: [fixture.root],
    verifyLand,
    landLeaseOptions: { pollMs: 5, heartbeatMs: 10 },
  }

  const first = landAgentBranch(
    { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
    options,
  )
  await firstStartedVerification
  const second = landAgentBranch({ projectPath: fixture.seed, branch: secondBranch }, options)
  await new Promise((resolve) => setTimeout(resolve, 30))
  releaseFirst()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(maximumActiveVerifications, 1)
  assert.notEqual(firstResult.land.mergeHead, secondResult.land.mergeHead)
  await git(['merge-base', '--is-ancestor', firstResult.land.mergeHead, secondResult.land.mergeHead], {
    cwd: fixture.seed,
  })
})

test('landAgentBranch fails closed on dirty checkout, conflicts, and non-agent branches', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return

  await assert.rejects(
    landAgentBranch({ projectPath: fixture.seed, branch: 'main' }, { allowedRoots: [fixture.root] }),
    (error) => error instanceof GitWorkflowError && error.code === 'invalid_agent_branch',
  )

  await writeFile(join(fixture.seed, 'README.md'), '# dirty\n')
  await assert.rejects(
    landAgentBranch(
      { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
      { allowedRoots: [fixture.root] },
    ),
    (error) => error instanceof GitWorkflowError && error.code === 'shared_checkout_dirty',
  )
  await git(['checkout', '--', 'README.md'], { cwd: fixture.seed })

  // Create a conflict: baseline edits the same file the agent branch created.
  await writeFile(join(fixture.seed, 'agent-feature.txt'), 'conflicting baseline version\n')
  await git(['add', 'agent-feature.txt'], { cwd: fixture.seed })
  await git(['commit', '-m', 'baseline conflict'], { cwd: fixture.seed })
  await assert.rejects(
    landAgentBranch(
      { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
      { allowedRoots: [fixture.root] },
    ),
    (error) => error instanceof GitWorkflowError
      && error.code === 'agent_branch_conflicts'
      && /agent-feature\.txt/.test(error.message),
  )
  // No merge left in progress.
  const status = (await git(['status', '--porcelain'], { cwd: fixture.seed })).stdout.trim()
  assert.equal(status, '')
})

test('landAgentBranch rejects landing when HEAD is detached', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return

  await git(['checkout', '--detach'], { cwd: fixture.seed })

  await assert.rejects(
    landAgentBranch(
      { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
      { allowedRoots: [fixture.root] },
    ),
    (error) => error instanceof GitWorkflowError && error.code === 'git_detached_head',
  )
})

test('landAgentBranch rejects landing an already-landed branch', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return

  const firstLand = await landAgentBranch(
    { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
    { allowedRoots: [fixture.root] },
  )
  assert.equal(firstLand.land.branch, 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')

  await assert.rejects(
    landAgentBranch(
      { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
      { allowedRoots: [fixture.root] },
    ),
    (error) => error instanceof GitWorkflowError && error.code === 'agent_branch_already_landed',
  )
})

test('landAgentBranch rolls the merge back when the land verification fails', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  const headBefore = (await git(['rev-parse', 'HEAD'], { cwd: fixture.seed })).stdout.trim()
  const seen = []

  await assert.rejects(
    landAgentBranch(
      { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
      {
        allowedRoots: [fixture.root],
        verifyLand: async (details) => {
          seen.push(details)
          return { ok: false, reason: 'the land check failed', output: "error TS2304: Cannot find name 'viewedFilePath'" }
        },
      },
    ),
    (error) => error instanceof GitWorkflowError
      && error.code === 'agent_branch_verification_failed'
      && error.message.includes('the land check failed')
      && error.verification?.output.includes('TS2304'),
  )

  assert.equal(seen.length, 1)
  assert.equal(seen[0].branch, 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(seen[0].mergedInto, 'main')
  assert.equal((await git(['rev-parse', 'HEAD'], { cwd: fixture.seed })).stdout.trim(), headBefore)
  assert.equal((await git(['status', '--porcelain'], { cwd: fixture.seed })).stdout.trim(), '')
  const after = await listUnlandedAgentWork(fixture.seed, { allowedRoots: [fixture.root] })
  assert.equal(after.branches.length, 1)
})

test('losing the repository lease after merge rolls the canonical checkout back', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  const headBefore = (await git(['rev-parse', 'HEAD'], { cwd: fixture.seed })).stdout.trim()
  const ownerPath = join(fixture.seed, '.git', 'ensync', 'repository-land.lock', 'owner.json')

  await assert.rejects(
    landAgentBranch(
      { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
      {
        allowedRoots: [fixture.root],
        verifyLand: async () => {
          await writeFile(ownerPath, JSON.stringify({
            schemaVersion: 1,
            token: 'foreign-owner-token',
            pid: process.pid,
            updatedAt: new Date().toISOString(),
          }))
          return { ok: true }
        },
      },
    ),
    (error) => error?.code === 'repository_land_lease_lost',
  )

  assert.equal((await git(['rev-parse', 'HEAD'], { cwd: fixture.seed })).stdout.trim(), headBefore)
  assert.equal((await git(['status', '--porcelain'], { cwd: fixture.seed })).stdout.trim(), '')
})

test('landAgentBranch lands normally when the land verification passes', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return

  const result = await landAgentBranch(
    { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
    {
      allowedRoots: [fixture.root],
      verifyLand: async (details) => {
        // The merge commit must already exist when the verification runs.
        const merged = (await git(['log', '-1', '--format=%s'], { cwd: details.repositoryPath })).stdout.trim()
        assert.equal(merged, 'Ensync land: ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
        return { ok: true }
      },
    },
  )

  assert.equal(result.land.mergedInto, 'main')
  const subject = (await git(['log', '-1', '--format=%s'], { cwd: fixture.seed })).stdout.trim()
  assert.equal(subject, 'Ensync land: ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
})

test('pushLandedBaseline pushes the landed baseline to its configured remote', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  await landAgentBranch(
    { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
    { allowedRoots: [fixture.root] },
  )

  const result = await pushLandedBaseline(fixture.seed, { allowedRoots: [fixture.root] })

  assert.equal(result.pushed, true)
  assert.equal(result.remote, 'origin')
  assert.equal(result.branch, 'main')
  const seedHead = (await git(['rev-parse', 'HEAD'], { cwd: fixture.seed })).stdout.trim()
  const remoteHead = (await git(['rev-parse', 'refs/heads/main'], { cwd: fixture.remote })).stdout.trim()
  assert.equal(seedHead, remoteHead)
})

test('pushLandedBaseline reports a missing remote without throwing', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  await git(['remote', 'remove', 'origin'], { cwd: fixture.seed })

  const result = await pushLandedBaseline(fixture.seed, { allowedRoots: [fixture.root] })

  assert.equal(result.pushed, false)
  assert.equal(result.code, 'git_remote_not_found')
})

test('pushLandedBaseline reports a diverged remote without force-pushing', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  await git(['clone', fixture.remote, fixture.clone])
  await git(['config', 'user.name', 'Relay Other'], { cwd: fixture.clone })
  await git(['config', 'user.email', 'relay-other@example.invalid'], { cwd: fixture.clone })
  await writeFile(join(fixture.clone, 'other.txt'), 'concurrent remote work\n')
  await git(['add', 'other.txt'], { cwd: fixture.clone })
  await git(['commit', '-m', 'Concurrent remote commit'], { cwd: fixture.clone })
  await git(['push', 'origin', 'main'], { cwd: fixture.clone })
  const remoteHeadBefore = (await git(['rev-parse', 'refs/heads/main'], { cwd: fixture.remote })).stdout.trim()

  await landAgentBranch(
    { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
    { allowedRoots: [fixture.root] },
  )
  const result = await pushLandedBaseline(fixture.seed, { allowedRoots: [fixture.root] })

  assert.equal(result.pushed, false)
  assert.equal(result.code, 'git_push_failed')
  const remoteHeadAfter = (await git(['rev-parse', 'refs/heads/main'], { cwd: fixture.remote })).stdout.trim()
  assert.equal(remoteHeadAfter, remoteHeadBefore)
})

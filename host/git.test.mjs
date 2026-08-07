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
  pushGit,
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

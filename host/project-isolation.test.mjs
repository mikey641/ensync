import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { ProjectIsolationError, ProjectIsolationService } from './project-isolation.mjs'
import { runGit } from './git.mjs'

const execFileAsync = promisify(execFile)

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
    maxBuffer: 512 * 1024,
  })
  return stdout.trim()
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-project-isolation-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repository')
  const workspaceRoot = join(root, 'agent-worktree-state')
  await mkdir(repository)
  await git(repository, ['init', '-b', 'main'])
  await git(repository, ['config', 'user.name', 'Ensync Test'])
  await git(repository, ['config', 'user.email', 'ensync-test@example.invalid'])
  await writeFile(join(repository, 'README.md'), '# project\n')
  await git(repository, ['add', 'README.md'])
  await git(repository, ['commit', '-m', 'initial'])
  return { repository, root, workspaceRoot }
}

function branchFor(workspaceKey) {
  const digest = createHash('sha256').update(workspaceKey).digest('hex').slice(0, 24)
  return `ensync/chat-${digest}`
}

test('separate chats use concurrent agent-worktree workspaces without lock files', async (context) => {
  const current = await fixture(context)
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })

  const [first, second] = await Promise.all([
    isolation.acquire(current.repository, 'chat:first'),
    isolation.acquire(current.repository, 'chat:second'),
  ])

  assert.notEqual(first.workspace.branch, second.workspace.branch)
  assert.notEqual(first.workspace.repositoryPath, second.workspace.repositoryPath)
  assert.equal(first.workspace.reused, false)
  assert.equal(second.workspace.reused, false)
  await assert.rejects(access(join(current.repository, '.git', 'ensync', 'workspace-write-locks')))
  await first.release()
  await second.release()
})

test('an identical active chat is rejected immediately by process-local ownership', async (context) => {
  const current = await fixture(context)
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })
  const first = await isolation.tryAcquireOrDescribe(current.repository, 'chat:same', {
    owner: { jobId: 'job_1111111111111111', provider: 'codex', targetKind: 'local' },
  })
  const occupied = await isolation.tryAcquireOrDescribe(current.repository, 'chat:same', {
    owner: { jobId: 'job_2222222222222222', provider: 'codex', targetKind: 'local' },
  })

  assert.equal(first.disposition, 'acquired')
  assert.equal(occupied.disposition, 'occupied')
  assert.equal(occupied.owner.jobId, 'job_1111111111111111')
  await first.lease.release()
  const resumed = await isolation.tryAcquireOrDescribe(current.repository, 'chat:same')
  assert.equal(resumed.disposition, 'acquired')
  assert.equal(resumed.lease.workspace.reused, true)
  await resumed.lease.release()
})

test('a dirty canonical checkout does not block worktree creation and preserves user bytes', async (context) => {
  const current = await fixture(context)
  const dirtyPath = join(current.repository, 'README.md')
  await writeFile(dirtyPath, '# unsaved user work\n')
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })

  const lease = await isolation.acquire(current.repository, 'chat:dirty')
  assert.equal(lease.workspace.reused, false)
  // The worktree is created from HEAD, not from the dirty working tree.
  const worktreeReadme = await readFile(join(lease.workspace.projectPath, 'README.md'), 'utf8')
  assert.equal(worktreeReadme, '# project\n')
  // The user's uncommitted changes are untouched in the shared checkout.
  assert.equal(await readFile(dirtyPath, 'utf8'), '# unsaved user work\n')
  await lease.release()
})

test('new workspace target metadata is durable before agent-worktree creation starts', async (context) => {
  const current = await fixture(context)
  const workspaceKey = 'chat:creation-crash'
  const branch = branchFor(workspaceKey)
  const expectedBase = await git(current.repository, ['rev-parse', 'main'])
  let metadataObserved = false
  const isolation = new ProjectIsolationService({
    rootPath: current.workspaceRoot,
    agentWorktreeClient: {
      async gitEnvironment() { return process.env },
      async create() {
        assert.equal(
          await git(current.repository, ['config', '--get', `branch.${branch}.ensyncTargetBranch`]),
          'main',
        )
        assert.equal(
          await git(current.repository, ['config', '--get', `branch.${branch}.ensyncTargetBaseSha`]),
          expectedBase,
        )
        metadataObserved = true
        throw new Error('simulated Host exit before worktree validation')
      },
    },
  })

  await assert.rejects(
    isolation.acquire(current.repository, workspaceKey),
    (error) => error instanceof ProjectIsolationError
      && error.code === 'managed_worktree_create_failed',
  )
  assert.equal(metadataObserved, true)
})

test('workspace admission cancellation reaches an in-flight agent-worktree create', async (context) => {
  const current = await fixture(context)
  let createSignal = null
  let createStarted
  const started = new Promise((resolve) => { createStarted = resolve })
  const isolation = new ProjectIsolationService({
    rootPath: current.workspaceRoot,
    agentWorktreeClient: {
      async gitEnvironment() { return process.env },
      async create(input) {
        createSignal = input.signal
        createStarted()
        await new Promise((resolve) => input.signal.addEventListener('abort', resolve, { once: true }))
        throw new Error('stopped')
      },
    },
  })
  const controller = new AbortController()
  const admission = isolation.acquire(current.repository, 'chat:cancel-create', {
    signal: controller.signal,
  })
  await started

  controller.abort()

  await assert.rejects(
    admission,
    (error) => error instanceof ProjectIsolationError && error.code === 'run_cancelled',
  )
  assert.equal(createSignal, controller.signal)
})

test('new workspace target capture retries a checkout interleave and keeps branch and SHA paired', async (context) => {
  const current = await fixture(context)
  await git(current.repository, ['branch', 'release', 'main'])
  let topLevelRead = false
  let switched = false
  const isolation = new ProjectIsolationService({
    rootPath: current.workspaceRoot,
    gitRunner: async (args, options) => {
      const result = await runGit(args, options)
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) topLevelRead = true
      if (
        topLevelRead
        && !switched
        && args[0] === 'symbolic-ref'
        && args.at(-1) === 'HEAD'
        && result.exitCode === 0
      ) {
        switched = true
        await git(current.repository, ['checkout', 'release'])
      }
      return result
    },
  })

  const lease = await isolation.acquire(current.repository, 'chat:target-interleave')

  assert.equal(switched, true)
  assert.equal(lease.workspace.base.branch, 'release')
  assert.equal(lease.workspace.base.canonicalSha, await git(current.repository, ['rev-parse', 'release']))
  await lease.release()
})

test('a restarted Host adopts a legacy worktree only when its creation reflog proves the target', async (context) => {
  const current = await fixture(context)
  const workspaceKey = 'chat:legacy'
  const branch = branchFor(workspaceKey)
  const legacyPath = join(current.root, 'legacy-worktree')
  const legacyBase = await git(current.repository, ['rev-parse', 'main'])
  await git(current.repository, ['branch', 'release', legacyBase])
  await git(current.repository, ['worktree', 'add', '-b', branch, legacyPath, legacyBase])
  const isolation = new ProjectIsolationService({
    rootPath: current.workspaceRoot,
    agentWorktreeClient: {
      async create() { throw new Error('registered legacy worktree must be adopted') },
    },
  })

  const lease = await isolation.acquire(current.repository, workspaceKey)

  assert.equal(lease.workspace.reused, true)
  assert.equal(lease.workspace.branch, branch)
  assert.equal(lease.workspace.repositoryPath, await realpath(legacyPath))
  assert.equal(lease.workspace.base.branch, 'main')
  assert.equal(await git(current.repository, ['config', '--get', `branch.${branch}.ensyncTargetBranch`]), 'main')
  assert.equal(await git(current.repository, ['config', '--get', `branch.${branch}.ensyncTargetBaseSha`]), legacyBase)
  await lease.release()
})

test('a rewritten target cannot make a reused conversation reintroduce removed history', async (context) => {
  const current = await fixture(context)
  const original = await git(current.repository, ['rev-parse', 'main'])
  await writeFile(join(current.repository, 'later.txt'), 'later target history\n')
  await git(current.repository, ['add', 'later.txt'])
  await git(current.repository, ['commit', '-m', 'later target history'])
  const removed = await git(current.repository, ['rev-parse', 'main'])
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })
  const first = await isolation.acquire(current.repository, 'chat:rewritten-target')
  assert.equal(first.workspace.base.canonicalSha, removed)
  await first.release()
  await git(current.repository, ['reset', '--hard', original])

  await assert.rejects(
    isolation.acquire(current.repository, 'chat:rewritten-target'),
    (error) => error instanceof ProjectIsolationError
      && error.code === 'managed_worktree_target_rewritten',
  )
  assert.equal(await git(current.repository, ['rev-parse', 'main']), original)
})

test('run-end snapshotting returns an exact commit with the repository identity', async (context) => {
  const current = await fixture(context)
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })
  const lease = await isolation.acquire(current.repository, 'chat:commit')
  await writeFile(join(lease.workspace.projectPath, 'feature.txt'), 'saved\n')

  const result = await isolation.commitAgentWork(lease.workspace, {
    outcome: 'succeeded',
    provider: 'codex',
    jobId: 'job_1111111111111111',
    turnId: 'turn-project-isolation',
  })

  assert.equal(result.committed, true)
  assert.match(result.head, /^[a-f0-9]{40}$/)
  assert.equal(await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%an <%ae>']), 'Ensync Test <ensync-test@example.invalid>')
  assert.match(await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%B']), /^Turn-ID: turn-project-isolation$/m)
  assert.equal(await git(lease.workspace.repositoryPath, ['status', '--porcelain']), '')
  await lease.release()
})

test('run-end snapshotting refuses a provider-switched branch', async (context) => {
  const current = await fixture(context)
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })
  const lease = await isolation.acquire(current.repository, 'chat:branch-switch')
  const conversationHead = await git(lease.workspace.repositoryPath, ['rev-parse', '--verify', lease.workspace.branch])
  await git(lease.workspace.repositoryPath, ['switch', '-c', 'provider-switched-branch'])
  await writeFile(join(lease.workspace.projectPath, 'feature.txt'), 'must not enqueue\n')

  await assert.rejects(
    isolation.commitAgentWork(lease.workspace, { outcome: 'succeeded' }),
    (error) => error instanceof ProjectIsolationError && error.code === 'managed_worktree_mismatch',
  )
  assert.equal(await git(lease.workspace.repositoryPath, ['rev-parse', '--verify', lease.workspace.branch]), conversationHead)
  await lease.release()
})

test('run-end snapshotting refuses files that appear after the commit', async (context) => {
  const current = await fixture(context)
  let injected = false
  const isolation = new ProjectIsolationService({
    rootPath: current.workspaceRoot,
    gitRunner: async (args, options) => {
      const result = await runGit(args, options)
      if (!injected && args.includes('commit') && args.includes('commit.gpgsign=false')) {
        injected = true
        await writeFile(join(options.cwd, 'after-commit.txt'), 'late mutation\n')
      }
      return result
    },
  })
  const lease = await isolation.acquire(current.repository, 'chat:late-mutation')
  await writeFile(join(lease.workspace.projectPath, 'feature.txt'), 'saved commit\n')

  await assert.rejects(
    isolation.commitAgentWork(lease.workspace, { outcome: 'succeeded' }),
    (error) => error instanceof ProjectIsolationError
      && error.code === 'agent_work_snapshot_incomplete',
  )
  assert.equal(injected, true)
  await lease.release()
})

test('run-end snapshotting never executes a repository-controlled post-commit hook', async (context) => {
  const current = await fixture(context)
  const marker = join(current.root, 'post-commit-ran')
  await git(current.repository, ['config', 'core.hooksPath', '.githooks'])
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })
  const lease = await isolation.acquire(current.repository, 'chat:no-post-commit-hook')
  await mkdir(join(lease.workspace.repositoryPath, '.githooks'), { recursive: true })
  const hook = join(lease.workspace.repositoryPath, '.githooks', 'post-commit')
  await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`)
  await chmod(hook, 0o755)
  await writeFile(join(lease.workspace.projectPath, 'feature.txt'), 'saved safely\n')

  const result = await isolation.commitAgentWork(lease.workspace, { outcome: 'succeeded' })

  assert.equal(result.committed, true)
  await assert.rejects(readFile(marker, 'utf8'), (error) => error?.code === 'ENOENT')
  await lease.release()
})

test('a reused chat does not merge a newer baseline before the provider starts', async (context) => {
  const current = await fixture(context)
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })
  const first = await isolation.acquire(current.repository, 'chat:no-baseline-merge')
  await writeFile(join(first.workspace.projectPath, 'chat.txt'), 'chat work\n')
  await isolation.commitAgentWork(first.workspace, { outcome: 'succeeded' })
  await first.release()
  await writeFile(join(current.repository, 'baseline.txt'), 'new baseline\n')
  await git(current.repository, ['add', 'baseline.txt'])
  await git(current.repository, ['commit', '-m', 'advance baseline'])

  const resumed = await isolation.acquire(current.repository, 'chat:no-baseline-merge')

  assert.equal(resumed.workspace.reused, true)
  await assert.rejects(readFile(join(resumed.workspace.projectPath, 'baseline.txt'), 'utf8'))
  assert.equal(resumed.workspace.integration.integrated, false)
  await resumed.release()
})

test('dirty leftovers in a reused worktree are recovered before the next provider run', async (context) => {
  const current = await fixture(context)
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })
  const first = await isolation.acquire(current.repository, 'chat:recovery')
  await writeFile(join(first.workspace.projectPath, 'leftover.txt'), 'from interrupted run\n')
  await first.release()

  const resumed = await isolation.acquire(current.repository, 'chat:recovery')

  assert.equal(await git(resumed.workspace.repositoryPath, ['status', '--porcelain']), '')
  assert.equal(await git(resumed.workspace.repositoryPath, ['log', '-1', '--format=%s']), 'Ensync agent work (recovered)')
  assert.equal(await readFile(join(resumed.workspace.projectPath, 'leftover.txt'), 'utf8'), 'from interrupted run\n')
  await resumed.release()
})

test('a project subdirectory maps to the same relative location in its worktree', async (context) => {
  const current = await fixture(context)
  const subproject = join(current.repository, 'packages', 'app')
  await mkdir(subproject, { recursive: true })
  await writeFile(join(subproject, 'package.json'), '{"name":"app"}\n')
  await git(current.repository, ['add', '.'])
  await git(current.repository, ['commit', '-m', 'add subproject'])
  const isolation = new ProjectIsolationService({ rootPath: current.workspaceRoot })

  const lease = await isolation.acquire(subproject, 'chat:subproject')

  assert.equal(lease.workspace.canonicalProjectPath, await realpath(subproject))
  assert.equal(await readFile(join(lease.workspace.projectPath, 'package.json'), 'utf8'), '{"name":"app"}\n')
  assert.notEqual(lease.workspace.projectPath, lease.workspace.repositoryPath)
  await lease.release()
})

test('a plain project folder still receives its safe initial Git baseline', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-project-init-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'plain-project')
  await mkdir(project)
  await writeFile(join(project, 'README.md'), '# plain\n')
  const isolation = new ProjectIsolationService({ rootPath: join(root, 'state') })

  const lease = await isolation.acquire(project, 'chat:init')

  assert.equal(await git(project, ['branch', '--show-current']), 'main')
  assert.match(await git(project, ['rev-parse', 'HEAD']), /^[a-f0-9]{40}$/)
  assert.equal(await readFile(join(lease.workspace.projectPath, 'README.md'), 'utf8'), '# plain\n')
  await lease.release()
})

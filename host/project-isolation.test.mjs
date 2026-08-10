import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runGit } from './git.mjs'
import { ChatRunService } from './chat.mjs'
import { ProjectIsolationError, ProjectIsolationService } from './project-isolation.mjs'

async function git(cwd, args) {
  const result = await runGit(args, { cwd })
  assert.equal(result.exitCode, 0, result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

async function repositoryFixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-isolation-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repository')
  await mkdir(repository)
  await git(repository, ['init', '--initial-branch=main'])
  await git(repository, ['config', 'user.name', 'Ensync Test'])
  await git(repository, ['config', 'user.email', 'ensync@example.test'])
  await writeFile(join(repository, 'tracked.txt'), 'baseline\n')
  await git(repository, ['add', 'tracked.txt'])
  await git(repository, ['commit', '-m', 'baseline'])
  return { root, repository, workspaceRoot: join(root, 'workspaces') }
}

function workspaceLockPath(repository, commonDirectory, key) {
  const workspaceHash = createHash('sha256').update(key).digest('hex').slice(0, 24)
  return join(repository, commonDirectory, 'ensync', 'workspace-write-locks', `${workspaceHash}.lock`)
}

test('a conversation receives a stable worktree without changing the shared checkout', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  const first = await isolation.acquire(fixture.repository, 'window-a:chat-a')
  assert.notEqual(first.workspace.projectPath, fixture.repository)
  assert.match(first.workspace.branch, /^ensync\/chat-[a-f0-9]{24}$/)
  assert.equal(first.workspace.reused, false)
  await writeFile(join(first.workspace.projectPath, 'agent-change.txt'), 'preserved\n')
  await first.release()

  await assert.rejects(readFile(join(fixture.repository, 'agent-change.txt')), { code: 'ENOENT' })
  assert.equal(await git(fixture.repository, ['status', '--porcelain']), '')

  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-a')
  assert.equal(resumed.workspace.reused, true)
  assert.equal(resumed.workspace.projectPath, first.workspace.projectPath)
  assert.equal(await readFile(join(resumed.workspace.projectPath, 'agent-change.txt'), 'utf8'), 'preserved\n')
  assert.equal(resumed.workspace.gitBefore.changedFiles, 1)
  await resumed.release()
})

test('a dirty shared checkout seeds a protected workspace without changing the shared checkout', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const baseline = await git(fixture.repository, ['rev-parse', 'HEAD'])
  await writeFile(join(fixture.repository, 'tracked.txt'), 'unique user change\n')
  await writeFile(join(fixture.repository, 'untracked.txt'), 'also unique\n')

  const acquired = await isolation.acquire(fixture.repository, 'window-a:new-chat')
  assert.equal(acquired.workspace.seededFromSharedCheckout, true)
  assert.equal(acquired.workspace.gitBefore.head, baseline)
  assert.equal(acquired.workspace.gitBefore.dirty, true)
  assert.equal(acquired.workspace.gitBefore.changedFiles, 2)
  assert.equal(await readFile(join(acquired.workspace.projectPath, 'tracked.txt'), 'utf8'), 'unique user change\n')
  assert.equal(await readFile(join(acquired.workspace.projectPath, 'untracked.txt'), 'utf8'), 'also unique\n')
  assert.equal(await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'), 'unique user change\n')
  assert.equal(await readFile(join(fixture.repository, 'untracked.txt'), 'utf8'), 'also unique\n')
  assert.equal((await git(fixture.repository, ['status', '--porcelain'])).split('\n').filter(Boolean).length, 2)
  await acquired.release()
})

test('separate Host instances allow different conversation worktrees in one repository to run concurrently', async (context) => {
  const fixture = await repositoryFixture(context)
  await writeFile(join(fixture.repository, 'tracked.txt'), 'shared dirty state\n')
  await writeFile(join(fixture.repository, 'untracked.txt'), 'shared untracked state\n')
  const firstService = new ProjectIsolationService({
    rootPath: join(fixture.root, 'host-a'),
    heartbeatMs: 20,
    lockStaleMs: 500,
    lockPollMs: 10,
  })
  const secondService = new ProjectIsolationService({
    rootPath: join(fixture.root, 'host-b'),
    heartbeatMs: 20,
    lockStaleMs: 500,
    lockPollMs: 10,
  })
  let firstWaiting = false
  let secondWaiting = false
  const [first, second] = await Promise.all([
    firstService.acquire(fixture.repository, 'window-a:chat-a', {
      onWait: () => { firstWaiting = true },
    }),
    secondService.acquire(fixture.repository, 'window-b:chat-b', {
      onWait: () => { secondWaiting = true },
    }),
  ])

  assert.equal(firstWaiting, false)
  assert.equal(secondWaiting, false)
  assert.notEqual(second.workspace.branch, first.workspace.branch)
  assert.equal(first.workspace.seededFromSharedCheckout, true)
  assert.equal(second.workspace.seededFromSharedCheckout, true)
  assert.equal(await readFile(join(first.workspace.projectPath, 'tracked.txt'), 'utf8'), 'shared dirty state\n')
  assert.equal(await readFile(join(second.workspace.projectPath, 'untracked.txt'), 'utf8'), 'shared untracked state\n')
  assert.equal((await git(fixture.repository, ['status', '--porcelain'])).split('\n').filter(Boolean).length, 2)
  first.assertHeld()
  second.assertHeld()
  await first.release()
  await second.release()
})

test('separate Host instances serialize duplicate runs against the same conversation worktree', async (context) => {
  const fixture = await repositoryFixture(context)
  const firstService = new ProjectIsolationService({
    rootPath: join(fixture.root, 'host-a'),
    heartbeatMs: 20,
    lockStaleMs: 500,
    lockPollMs: 10,
  })
  const secondService = new ProjectIsolationService({
    rootPath: join(fixture.root, 'host-b'),
    heartbeatMs: 20,
    lockStaleMs: 500,
    lockPollMs: 10,
  })
  const key = 'window-a:chat-a'
  const first = await firstService.acquire(fixture.repository, key)
  let waiting = false
  let secondResolved = false
  const secondPromise = secondService.acquire(fixture.repository, key, {
    onWait: () => { waiting = true },
  }).then((lease) => {
    secondResolved = true
    return lease
  })

  for (let attempts = 0; attempts < 100 && !waiting; attempts += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  assert.equal(waiting, true)
  assert.equal(secondResolved, false)

  await first.release()
  const second = await secondPromise
  assert.equal(secondResolved, true)
  assert.equal(second.workspace.branch, first.workspace.branch)
  assert.equal(second.workspace.projectPath, first.workspace.projectPath)
  await second.release()
})

test('a cancelled lock waiter never starts or steals the active workspace', async (context) => {
  const fixture = await repositoryFixture(context)
  const firstService = new ProjectIsolationService({ rootPath: join(fixture.root, 'host-a'), lockPollMs: 10 })
  const secondService = new ProjectIsolationService({ rootPath: join(fixture.root, 'host-b'), lockPollMs: 10 })
  const first = await firstService.acquire(fixture.repository, 'window-a:chat-a')
  const controller = new AbortController()
  let waiting = false
  const pending = secondService.acquire(fixture.repository, 'window-a:chat-a', {
    signal: controller.signal,
    onWait: () => { waiting = true },
  })
  for (let attempts = 0; attempts < 100 && !waiting; attempts += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'run_cancelled')
  first.assertHeld()
  await first.release()
})

test('an abandoned stale lease is quarantined before a new Host proceeds', async (context) => {
  const fixture = await repositoryFixture(context)
  const commonDirectory = await git(fixture.repository, ['rev-parse', '--git-common-dir'])
  const key = 'window-a:chat-a'
  const lockPath = workspaceLockPath(fixture.repository, commonDirectory, key)
  const ownerPath = join(lockPath, 'owner.json')
  await mkdir(lockPath, { recursive: true })
  await writeFile(ownerPath, JSON.stringify({
    version: 2,
    token: 'abandoned',
    pid: 999_999,
    workspaceHash: createHash('sha256').update(key).digest('hex').slice(0, 24),
    acquiredAt: '2020-01-01T00:00:00.000Z',
    heartbeatAt: '2020-01-01T00:00:00.000Z',
  }))
  const old = new Date('2020-01-01T00:00:00.000Z')
  await utimes(ownerPath, old, old)
  await utimes(lockPath, old, old)

  const isolation = new ProjectIsolationService({
    rootPath: fixture.workspaceRoot,
    lockStaleMs: 10,
    lockPollMs: 5,
  })
  const lease = await isolation.acquire(fixture.repository, key)
  lease.assertHeld()
  await lease.release()
  await assert.rejects(stat(lockPath), { code: 'ENOENT' })
})

test('a stale heartbeat is never stolen while its Host process is still alive', async (context) => {
  const fixture = await repositoryFixture(context)
  const commonDirectory = await git(fixture.repository, ['rev-parse', '--git-common-dir'])
  const key = 'window-a:chat-a'
  const lockPath = workspaceLockPath(fixture.repository, commonDirectory, key)
  const ownerPath = join(lockPath, 'owner.json')
  await mkdir(lockPath, { recursive: true })
  await writeFile(ownerPath, JSON.stringify({
    version: 2,
    token: 'suspended-live-host',
    pid: process.pid,
    workspaceHash: createHash('sha256').update(key).digest('hex').slice(0, 24),
    acquiredAt: '2020-01-01T00:00:00.000Z',
    heartbeatAt: '2020-01-01T00:00:00.000Z',
  }))
  const old = new Date('2020-01-01T00:00:00.000Z')
  await utimes(ownerPath, old, old)
  await utimes(lockPath, old, old)

  const controller = new AbortController()
  const isolation = new ProjectIsolationService({
    rootPath: fixture.workspaceRoot,
    lockStaleMs: 10,
    lockPollMs: 5,
  })
  const pending = isolation.acquire(fixture.repository, key, {
    signal: controller.signal,
    onWait: () => controller.abort(),
  })

  await assert.rejects(pending, (error) => error.code === 'run_cancelled')
  assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).token, 'suspended-live-host')
})

test('non-Git projects fail closed before provider execution', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-non-git-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const isolation = new ProjectIsolationService({ rootPath: join(root, 'workspaces') })

  await assert.rejects(
    isolation.acquire(root, 'window-a:chat-a'),
    (error) => error instanceof ProjectIsolationError && error.code === 'project_isolation_required',
  )
})

test('ChatRunService binds provider cwd to the protected worktree and releases its lease', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const events = []
  let providerCwd
  let providerPrompt
  const service = new ChatRunService({
    projectIsolation: isolation,
    statusService: {
      async get() {
        return {
          id: 'claude',
          name: 'Claude Code',
          installed: true,
          executable: '/test/bin/claude',
          authentication: { state: 'authenticated', method: 'claude.ai OAuth' },
        }
      },
      invalidate() {},
    },
    processRunner: async (_executable, _args, options) => {
      providerCwd = options.cwd
      providerPrompt = options.input
      await writeFile(join(options.cwd, 'provider-change.txt'), 'isolated\n')
      return {
        exitCode: 0,
        error: null,
        timedOut: false,
        aborted: false,
        stderr: '',
        stdout: JSON.stringify({
          type: 'result',
          is_error: false,
          result: 'completed safely',
          session_id: '123e4567-e89b-12d3-a456-426614174000',
          usage: {},
        }),
      }
    },
  })

  const result = await service.run({
    provider: 'claude',
    projectPath: fixture.repository,
    workspaceKey: 'window-a:chat-a',
    prompt: 'Make one change',
  }, { onEvent: (event) => events.push(event) })

  assert.equal(result.projectPath, await realpath(fixture.repository))
  assert.equal(result.workspace.path, providerCwd)
  assert.notEqual(providerCwd, fixture.repository)
  assert.match(providerPrompt, /current working directory as the only writable project/i)
  assert.match(providerPrompt, /Make one change$/)
  assert.deepEqual(events.slice(0, 2).map((event) => event.code ?? event.type), [
    'project_workspace_ready',
    'started',
  ])
  await assert.rejects(readFile(join(fixture.repository, 'provider-change.txt')), { code: 'ENOENT' })

  const next = await isolation.acquire(fixture.repository, 'window-b:chat-b')
  next.assertHeld()
  await next.release()
})

test('ChatRunService runs different chats in the same repository concurrently', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({
    rootPath: fixture.workspaceRoot,
    heartbeatMs: 20,
    lockPollMs: 10,
  })
  let releaseFirst
  const firstGate = new Promise((resolveGate) => { releaseFirst = resolveGate })
  let firstStarted
  const firstStartedPromise = new Promise((resolveStarted) => { firstStarted = resolveStarted })
  let secondStarted
  const secondStartedPromise = new Promise((resolveStarted) => { secondStarted = resolveStarted })
  let activeProviders = 0
  let maximumActiveProviders = 0
  const providerPaths = []
  const service = new ChatRunService({
    projectIsolation: isolation,
    statusService: {
      async get() {
        return {
          id: 'claude',
          name: 'Claude Code',
          installed: true,
          executable: '/test/bin/claude',
          authentication: { state: 'authenticated', method: 'claude.ai OAuth' },
        }
      },
      invalidate() {},
    },
    processRunner: async (_executable, _args, options) => {
      activeProviders += 1
      maximumActiveProviders = Math.max(maximumActiveProviders, activeProviders)
      providerPaths.push(options.cwd)
      try {
        if (providerPaths.length === 1) {
          firstStarted()
          await firstGate
        } else if (providerPaths.length === 2) {
          secondStarted()
        }
        return {
          exitCode: 0,
          error: null,
          timedOut: false,
          aborted: false,
          stderr: '',
          stdout: JSON.stringify({
            type: 'result',
            is_error: false,
            result: 'completed safely',
            session_id: null,
            usage: {},
          }),
        }
      } finally {
        activeProviders -= 1
      }
    },
  })

  const first = service.run({
    provider: 'claude',
    projectPath: fixture.repository,
    workspaceKey: 'window-a:chat-a',
    prompt: 'First change',
  })
  await firstStartedPromise

  const secondEvents = []
  const second = service.run({
    provider: 'claude',
    projectPath: fixture.repository,
    workspaceKey: 'window-b:chat-b',
    prompt: 'Second change',
  }, { onEvent: (event) => secondEvents.push(event) })
  await secondStartedPromise

  assert.equal(secondEvents.some((event) => event.code === 'workspace_write_lock_waiting'), false)
  assert.equal(providerPaths.length, 2)
  assert.equal(maximumActiveProviders, 2)
  releaseFirst()
  await Promise.all([first, second])

  assert.equal(providerPaths.length, 2)
  assert.notEqual(providerPaths[0], providerPaths[1])
  assert.equal(maximumActiveProviders, 2)
  assert.equal(await git(fixture.repository, ['status', '--porcelain']), '')
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { runGit } from './git.mjs'
import { ChatRunService } from './chat.mjs'
import { ProjectIsolationError, ProjectIsolationService } from './project-isolation.mjs'

// Old enough to be stale against the tests' lockStaleMs, recent enough that the
// owner process it names was already running when it was written.
const STALE_BUT_POSSIBLE_HEARTBEAT = new Date(Date.now() - 1_000).toISOString()
// Predates every process alive on this machine, so any PID paired with it must
// have been reissued since.
const HEARTBEAT_FROM_A_PREVIOUS_BOOT = '2020-01-01T00:00:00.000Z'

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

async function remoteRepositoryFixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-canonical-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const remote = join(root, 'remote.git')
  await git(root, ['init', '--bare', '--initial-branch=main', remote])

  const publisher = join(root, 'publisher')
  await git(root, ['clone', remote, publisher])
  await git(publisher, ['config', 'user.name', 'Ensync Test'])
  await git(publisher, ['config', 'user.email', 'ensync@example.test'])
  await writeFile(join(publisher, 'tracked.txt'), 'baseline\n')
  await git(publisher, ['add', 'tracked.txt'])
  await git(publisher, ['commit', '-m', 'baseline'])
  await git(publisher, ['push', '-u', 'origin', 'main'])

  const repository = join(root, 'repository')
  await git(root, ['clone', remote, repository])
  await git(repository, ['config', 'user.name', 'Ensync Test'])
  await git(repository, ['config', 'user.email', 'ensync@example.test'])

  return {
    root,
    remote,
    publisher,
    repository,
    workspaceRoot: join(root, 'workspaces'),
    async publish(name, contents, message) {
      await writeFile(join(publisher, name), contents)
      await git(publisher, ['add', name])
      await git(publisher, ['commit', '-m', message])
      await git(publisher, ['push', 'origin', 'main'])
      return git(publisher, ['rev-parse', 'HEAD'])
    },
  }
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
  assert.equal(resumed.workspace.gitBefore.changedFiles, 0)
  assert.equal(await git(resumed.workspace.repositoryPath, ['log', '-1', '--format=%s']), 'Ensync agent work (recovered)')
  await resumed.release()
})

test('acquire commits crash leftovers in a reused worktree as recovered work', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  const first = await isolation.acquire(fixture.repository, 'window-a:chat-recover')
  await writeFile(join(first.workspace.projectPath, 'crash-leftover.txt'), 'left behind\n')
  await first.release()

  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-recover')
  context.after(() => resumed.release())
  assert.equal(await git(resumed.workspace.repositoryPath, ['status', '--porcelain']), '')
  const subject = await git(resumed.workspace.repositoryPath, ['log', '-1', '--format=%s'])
  assert.equal(subject, 'Ensync agent work (recovered)')
  // The recovered content is durable on the branch.
  const shown = await git(resumed.workspace.repositoryPath, ['show', 'HEAD:crash-leftover.txt'])
  assert.equal(shown, 'left behind')
})

test('a first-time seeded conversation still exposes inherited shared-checkout state as uncommitted work', async (context) => {
  const fixture = await repositoryFixture(context)
  await writeFile(join(fixture.repository, 'tracked.txt'), 'user edit\n')
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-seeded')
  context.after(() => lease.release())
  assert.equal(lease.workspace.seededFromSharedCheckout, true)
  assert.equal(lease.workspace.gitBefore.dirty, true)
  const subject = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%s'])
  assert.equal(subject, 'baseline')
})

test('a dirty shared checkout seeds a protected workspace without changing the shared checkout', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const baseline = await git(fixture.repository, ['rev-parse', 'HEAD'])
  await git(fixture.repository, ['config', 'core.autocrlf', 'true'])
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

test('a rapid lease heartbeat never corrupts its owner record', async (context) => {
  const fixture = await repositoryFixture(context)
  const service = new ProjectIsolationService({
    rootPath: join(fixture.root, 'host-a'),
    heartbeatMs: 1,
    lockStaleMs: 5_000,
    lockPollMs: 10,
  })
  const acquired = await service.acquire(fixture.repository, 'window-a:chat-a')
  const ownerPath = join(workspaceLockPath(fixture.repository, '.git', 'window-a:chat-a'), 'owner.json')
  const deadline = Date.now() + 400
  while (Date.now() < deadline) {
    JSON.parse(await readFile(ownerPath, 'utf8'))
    acquired.assertHeld()
  }
  acquired.assertHeld()
  await acquired.release()
})

test('non-blocking admission describes the active conversation without waiting', async (context) => {
  const fixture = await repositoryFixture(context)
  const serviceA = new ProjectIsolationService({ rootPath: join(fixture.root, 'host-a'), lockPollMs: 10 })
  const serviceB = new ProjectIsolationService({ rootPath: join(fixture.root, 'host-b'), lockPollMs: 10 })
  const owner = {
    jobId: 'job_1111111111111111',
    provider: 'codex',
    targetKind: 'local',
    startedAt: '2026-08-11T10:00:00.000Z',
    providerProcessStarted: false,
    steerable: false,
    nativeWorkspaceId: '11111111-1111-4111-8111-111111111111',
  }
  const first = await serviceA.tryAcquireOrDescribe(fixture.repository, 'workspace:chat-a', { owner })
  try {
    let waiting = false
    const startedAt = Date.now()
    const second = await serviceB.tryAcquireOrDescribe(fixture.repository, 'workspace:chat-a', {
      owner: { jobId: 'job_2222222222222222', provider: 'claude', targetKind: 'local' },
      onWait: () => { waiting = true },
    })
    assert.ok(Date.now() - startedAt < 500)
    assert.equal(waiting, false)
    assert.equal(first.disposition, 'acquired')
    assert.deepEqual(second, { disposition: 'occupied', owner })

    const different = await serviceB.tryAcquireOrDescribe(fixture.repository, 'workspace:chat-b', { owner })
    assert.equal(different.disposition, 'acquired')
    if (different.disposition === 'acquired') await different.lease.release()
  } finally {
    if (first.disposition === 'acquired') await first.lease.release()
  }
})

test('bounded occupied owner reflects heartbeat updates only', async (context) => {
  const fixture = await repositoryFixture(context)
  const serviceA = new ProjectIsolationService({ rootPath: join(fixture.root, 'host-a'), heartbeatMs: 5 })
  const serviceB = new ProjectIsolationService({ rootPath: join(fixture.root, 'host-b'), heartbeatMs: 5 })
  const first = await serviceA.tryAcquireOrDescribe(fixture.repository, 'workspace:chat-a', {
    owner: {
      jobId: 'job_1111111111111111', provider: 'codex', targetKind: 'local',
      startedAt: '2026-08-11T10:00:00.000Z', providerProcessStarted: false,
      steerable: false, nativeWorkspaceId: '11111111-1111-4111-8111-111111111111', extra: 'not-public',
    },
  })
  try {
    assert.equal(first.disposition, 'acquired')
    if (first.disposition !== 'acquired') return
    await first.lease.updateOwner({ providerProcessStarted: true, steerable: true, token: 'not-public' })

    const second = await serviceB.tryAcquireOrDescribe(fixture.repository, 'workspace:chat-a')
    assert.deepEqual(second, {
      disposition: 'occupied',
      owner: {
        jobId: 'job_1111111111111111', provider: 'codex', targetKind: 'local',
        startedAt: '2026-08-11T10:00:00.000Z', providerProcessStarted: true,
        steerable: true, nativeWorkspaceId: '11111111-1111-4111-8111-111111111111',
      },
    })
  } finally {
    if (first.disposition === 'acquired') await first.lease.release()
  }
})

test('release fences an unawaited owner update before removing its lock', async (context) => {
  const fixture = await repositoryFixture(context)
  const commonDirectory = await git(fixture.repository, ['rev-parse', '--git-common-dir'])
  const service = new ProjectIsolationService({ rootPath: fixture.workspaceRoot, heartbeatMs: 1 })
  const key = 'workspace:chat-a'
  const acquired = await service.tryAcquireOrDescribe(fixture.repository, key, {
    owner: { jobId: 'job_1111111111111111', provider: 'codex', targetKind: 'local' },
  })
  assert.equal(acquired.disposition, 'acquired')
  if (acquired.disposition !== 'acquired') return
  acquired.lease.updateOwner({ providerProcessStarted: true })
  await acquired.lease.release()
  await assert.rejects(stat(workspaceLockPath(fixture.repository, commonDirectory, key)), { code: 'ENOENT' })
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

test('a stale heartbeat is never stolen while another Host process is still alive', async (context) => {
  const fixture = await repositoryFixture(context)
  const commonDirectory = await git(fixture.repository, ['rev-parse', '--git-common-dir'])
  const key = 'window-a:chat-a'
  const lockPath = workspaceLockPath(fixture.repository, commonDirectory, key)
  const ownerPath = join(lockPath, 'owner.json')
  await mkdir(lockPath, { recursive: true })
  await writeFile(ownerPath, JSON.stringify({
    version: 2,
    token: 'suspended-live-host',
    // Process 1 exists on every supported platform, so this stands in for
    // another Host that is alive but suspended.
    pid: 1,
    workspaceHash: createHash('sha256').update(key).digest('hex').slice(0, 24),
    acquiredAt: STALE_BUT_POSSIBLE_HEARTBEAT,
    // Stale against lockStaleMs, yet later than this owner started. A heartbeat
    // predating its own writer would instead describe a reissued PID, which the
    // reclamation test below covers.
    heartbeatAt: STALE_BUT_POSSIBLE_HEARTBEAT,
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

test('a lock whose PID was reissued after a reboot is reclaimed, not guarded forever', async (context) => {
  const fixture = await repositoryFixture(context)
  const commonDirectory = await git(fixture.repository, ['rev-parse', '--git-common-dir'])
  const key = 'window-a:chat-a'
  const lockPath = workspaceLockPath(fixture.repository, commonDirectory, key)
  const ownerPath = join(lockPath, 'owner.json')
  await mkdir(lockPath, { recursive: true })
  await writeFile(ownerPath, JSON.stringify({
    version: 2,
    token: 'host-that-died-in-a-reboot',
    // Alive, but it started long after this heartbeat was written, so it cannot
    // be the Host that wrote it — the PID was reissued across the reboot.
    pid: 1,
    workspaceHash: createHash('sha256').update(key).digest('hex').slice(0, 24),
    acquiredAt: HEARTBEAT_FROM_A_PREVIOUS_BOOT,
    heartbeatAt: HEARTBEAT_FROM_A_PREVIOUS_BOOT,
  }))
  const old = new Date(HEARTBEAT_FROM_A_PREVIOUS_BOOT)
  await utimes(ownerPath, old, old)
  await utimes(lockPath, old, old)

  const isolation = new ProjectIsolationService({
    rootPath: fixture.workspaceRoot,
    lockStaleMs: 10,
    lockPollMs: 5,
  })
  const lease = await isolation.acquire(fixture.repository, key)
  context.after(() => lease.release())
  assert.notEqual(JSON.parse(await readFile(ownerPath, 'utf8')).token, 'host-that-died-in-a-reboot')
})

test('a lease this Host still holds is never stolen when its own heartbeat freezes', async (context) => {
  const fixture = await repositoryFixture(context)
  const key = 'window-a:chat-a'
  const holder = new ProjectIsolationService({
    rootPath: fixture.workspaceRoot,
    // Long enough that no tick rewrites the record this test freezes.
    heartbeatMs: 60_000,
    lockPollMs: 5,
  })
  const lease = await holder.acquire(fixture.repository, key)
  context.after(() => lease.release())
  const lockPath = workspaceLockPath(fixture.repository, '.git', key)
  const ownerPath = join(lockPath, 'owner.json')
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
  await writeFile(ownerPath, JSON.stringify({ ...owner, heartbeatAt: STALE_BUT_POSSIBLE_HEARTBEAT }))
  const old = new Date('2020-01-01T00:00:00.000Z')
  await utimes(ownerPath, old, old)
  await utimes(lockPath, old, old)

  const controller = new AbortController()
  const waiter = new ProjectIsolationService({
    rootPath: fixture.workspaceRoot,
    lockStaleMs: 10,
    lockPollMs: 5,
  })
  const pending = waiter.acquire(fixture.repository, key, {
    signal: controller.signal,
    onWait: () => controller.abort(),
  })

  await assert.rejects(pending, (error) => error.code === 'run_cancelled')
  assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).token, owner.token)
  lease.assertHeld()
})

test('a lease this Host leaked is reclaimed instead of being guarded by its own pid forever', async (context) => {
  const fixture = await repositoryFixture(context)
  const commonDirectory = await git(fixture.repository, ['rev-parse', '--git-common-dir'])
  const key = 'window-a:chat-a'
  const lockPath = workspaceLockPath(fixture.repository, commonDirectory, key)
  const ownerPath = join(lockPath, 'owner.json')
  await mkdir(lockPath, { recursive: true })
  // Every lease records the shared Host daemon's pid, so a lock this very
  // process abandoned looks exactly like one it is still using. Only the token
  // separates them, and this one was never handed out.
  await writeFile(ownerPath, JSON.stringify({
    version: 2,
    token: 'leaked-by-this-host',
    pid: process.pid,
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
  assert.notEqual(JSON.parse(await readFile(ownerPath, 'utf8')).token, 'leaked-by-this-host')
  await lease.release()
})

test('a release that cannot remove the lock reports it instead of reporting a clean release', async (context) => {
  if (process.getuid?.() === 0) return // root ignores the directory permission this test relies on
  const fixture = await repositoryFixture(context)
  const key = 'window-a:chat-a'
  const isolation = new ProjectIsolationService({
    rootPath: fixture.workspaceRoot,
    heartbeatMs: 60_000,
    lockPollMs: 5,
  })
  const lease = await isolation.acquire(fixture.repository, key)
  const lockPath = workspaceLockPath(fixture.repository, '.git', key)
  const lockParent = dirname(lockPath)

  await chmod(lockParent, 0o500)
  let outcome
  try {
    outcome = await lease.release()
  } finally {
    await chmod(lockParent, 0o700)
  }

  assert.equal(outcome.removed, false)
  assert.match(outcome.reason, /lease/i)
  await stat(lockPath)
  await rm(lockPath, { recursive: true, force: true })
})

test('a lease released while its heartbeat is writing leaves no lock behind', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({
    rootPath: fixture.workspaceRoot,
    // A tick every millisecond puts a write in flight across the release.
    heartbeatMs: 1,
    lockPollMs: 5,
  })
  const lockPath = workspaceLockPath(fixture.repository, '.git', 'window-a:chat-a')

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const lease = await isolation.acquire(fixture.repository, 'window-a:chat-a')
    await new Promise((resolveWait) => setTimeout(resolveWait, 3))
    const outcome = await lease.release()
    assert.equal(outcome.removed, true, `release ${attempt} reported a lock it could not remove`)
    await assert.rejects(stat(lockPath), { code: 'ENOENT' }, `release ${attempt} left a lock behind`)
  }
})

test('a project folder outside Git is given a repository so isolated work can start', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-non-git-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'notes.md'), 'baseline\n')
  const isolation = new ProjectIsolationService({ rootPath: join(root, 'workspaces') })

  const lease = await isolation.acquire(project, 'window-a:chat-a')
  context.after(() => lease.release())

  assert.equal(await git(project, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
  assert.equal(await git(project, ['show', 'HEAD:notes.md']), 'baseline')
  // The protected worktree carries the project the person opened.
  assert.equal(await readFile(join(lease.workspace.projectPath, 'notes.md'), 'utf8'), 'baseline\n')
})

test('a host with automatic repository creation off still fails closed without Git plumbing text', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-non-git-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const isolation = new ProjectIsolationService({
    rootPath: join(root, 'workspaces'),
    autoInitializeGit: false,
  })

  const error = await isolation.acquire(root, 'window-a:chat-a').then(() => null, (thrown) => thrown)

  assert.ok(error instanceof ProjectIsolationError)
  assert.equal(error.code, 'project_isolation_required')
  assert.doesNotMatch(error.message, /fatal:/i)
  assert.doesNotMatch(error.message, /any of the parent directories/i)
  await assert.rejects(stat(join(root, '.git')), { code: 'ENOENT' })
})

test('a home directory is never turned into one Ensync project repository', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-home-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const isolation = new ProjectIsolationService({ rootPath: join(root, 'workspaces'), homePath: root })

  const error = await isolation.acquire(root, 'window-a:chat-a').then(() => null, (thrown) => thrown)

  assert.ok(error instanceof ProjectIsolationError)
  assert.equal(error.code, 'project_isolation_required')
  assert.match(error.message, /home directory/i)
  await assert.rejects(stat(join(root, '.git')), { code: 'ENOENT' })
})

test('a stale renderer without a conversation key gets an actionable restart error', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  await assert.rejects(
    isolation.acquire(fixture.repository, undefined),
    (error) => error instanceof ProjectIsolationError
      && error.code === 'client_upgrade_required'
      && error.message.includes('Quit Ensync completely'),
  )
})

test('ChatRunService binds provider cwd to the protected worktree and releases its lease', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const events = []
  let providerCwd
  let providerPrompt
  // Automatic landing is off so the assertions observe pure isolation:
  // nothing may reach the shared checkout, not even a guarded land merge.
  const service = new ChatRunService({
    projectIsolation: isolation,
    autoLand: false,
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

test('commitAgentWork commits worktree changes to the conversation branch with the Ensync Agent identity', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-commit')
  context.after(() => lease.release())

  await writeFile(join(lease.workspace.projectPath, 'agent-file.txt'), 'work\n')
  const result = await isolation.commitAgentWork(lease.workspace, {
    outcome: 'succeeded',
    provider: 'codex',
    jobId: 'job-1',
  })

  assert.equal(result.committed, true)
  assert.equal(result.changedFiles, 1)
  assert.match(result.head, /^[a-f0-9]{40}$/)
  const author = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%an <%ae>'])
  assert.equal(author, 'Ensync Agent <agent@ensync.local>')
  const committer = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%cn <%ce>'])
  assert.equal(committer, 'Ensync Agent <agent@ensync.local>')
  const subject = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%s'])
  assert.equal(subject, 'Ensync agent work (succeeded)')
  const body = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%b'])
  assert.match(body, /Provider: codex/)
  assert.match(body, /Job: job-1/)
  assert.equal(await git(lease.workspace.repositoryPath, ['status', '--porcelain']), '')
  // Shared checkout untouched.
  assert.equal(await git(fixture.repository, ['status', '--porcelain']), '')
})

test('a chat run auto-commits agent work at run end, on success and on failure', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  for (const [key, exitCode, outcome] of [
    ['window-a:chat-autocommit-ok', 0, 'succeeded'],
    ['window-a:chat-autocommit-fail', 1, 'failed'],
  ]) {
    const events = []
    let worktreeProjectPath = null
    // Automatic landing is off so the second iteration's fresh worktree does not
    // already contain the first iteration's landed file, which would make its
    // identical agent write a no-op and suppress the auto-commit under test.
    const chats = new ChatRunService({
      projectIsolation: isolation,
      autoLand: false,
      statusService: {
        async get() {
          return {
            id: 'codex',
            name: 'Codex',
            installed: true,
            executable: '/test/bin/codex',
            authentication: { state: 'authenticated', method: 'chatgpt' },
          }
        },
        invalidate() {},
      },
      processRunner: async (_executable, _args, options) => {
        worktreeProjectPath = options.cwd
        await writeFile(join(options.cwd, 'made-by-agent.txt'), 'partial or complete work\n')
        return {
          exitCode,
          stdout: exitCode === 0
            ? '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{}}\n'
            : '',
          stderr: exitCode === 0 ? '' : 'provider exploded',
          aborted: false,
          timedOut: false,
          error: null,
        }
      },
    })

    const run = chats.run(
      { provider: 'codex', prompt: 'do work', projectPath: fixture.repository, workspaceKey: key },
      { onEvent: (event) => events.push(event) },
    )
    if (exitCode === 0) await run
    else await assert.rejects(run)

    const committed = events.find((event) => event.code === 'agent_work_committed')
    assert.ok(committed, `expected agent_work_committed event for exit ${exitCode}`)
    assert.match(committed.message, /made-by-agent|1 changed file/i)
    const branchLog = await git(worktreeProjectPath, ['log', '-1', '--format=%s'])
    assert.equal(branchLog, `Ensync agent work (${outcome})`)
    assert.equal(await git(worktreeProjectPath, ['status', '--porcelain']), '')
  }
})

test('a chat run skips auto-commit when the workspace write lease is lost', async (context) => {
  const fixture = await repositoryFixture(context)
  const headBefore = await git(fixture.repository, ['rev-parse', 'HEAD'])
  await writeFile(join(fixture.repository, 'agent-in-worktree.txt'), 'work left behind by another owner\n')

  const leaseController = new AbortController()
  leaseController.abort(new Error('Ensync Host lost the protected workspace write lease: lease stolen by another Host.'))
  let commitCalls = 0
  const fakeIsolation = {
    async acquire() {
      return {
        workspace: {
          projectPath: fixture.repository,
          repositoryPath: fixture.repository,
          branch: 'ensync/chat-lease-lost',
          reused: false,
          shared: { repositoryPath: fixture.repository, head: headBefore, statusEntries: [] },
          gitBefore: { branch: 'ensync/chat-lease-lost', head: headBefore, changedFiles: 0, dirty: false },
        },
        signal: leaseController.signal,
        assertHeld() {
          if (leaseController.signal.aborted) throw leaseController.signal.reason
        },
        release: async () => {},
      }
    },
    async commitAgentWork() {
      commitCalls += 1
      return { committed: true, changedFiles: 1, head: 'deadbeef' }
    },
  }

  const events = []
  const chats = new ChatRunService({
    projectIsolation: fakeIsolation,
    statusService: {
      async get() {
        return {
          id: 'codex',
          name: 'Codex',
          installed: true,
          executable: '/test/bin/codex',
          authentication: { state: 'authenticated', method: 'chatgpt' },
        }
      },
      invalidate() {},
    },
    processRunner: async () => ({
      exitCode: 0,
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{}}\n',
      stderr: '',
      aborted: false,
      timedOut: false,
      error: null,
    }),
  })

  await assert.rejects(
    chats.run(
      { provider: 'codex', prompt: 'do work', projectPath: fixture.repository, workspaceKey: 'window-a:chat-lease-lost' },
      { onEvent: (event) => events.push(event) },
    ),
    (error) => error.code === 'workspace_write_lock_lost',
  )

  assert.equal(commitCalls, 0)
  assert.equal(events.some((event) => event.code === 'agent_work_committed'), false)
  assert.equal(events.some((event) => event.code === 'agent_work_commit_failed'), false)
})

test('acquire merges new baseline commits into a reused conversation branch', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  const first = await isolation.acquire(fixture.repository, 'window-a:chat-sync')
  await writeFile(join(first.workspace.projectPath, 'agent-work.txt'), 'agent side\n')
  await first.release()

  // Baseline advances (as if another chat landed work).
  await writeFile(join(fixture.repository, 'landed.txt'), 'landed by another chat\n')
  await git(fixture.repository, ['add', 'landed.txt'])
  await git(fixture.repository, ['commit', '-m', 'Ensync land: ensync/chat-other'])

  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-sync')
  context.after(() => resumed.release())
  const landed = await git(resumed.workspace.repositoryPath, ['show', 'HEAD:landed.txt'])
  assert.equal(landed, 'landed by another chat')
  // Recovery-committed agent work survives the merge.
  const agentSide = await git(resumed.workspace.repositoryPath, ['show', 'HEAD:agent-work.txt'])
  assert.equal(agentSide, 'agent side')
  assert.equal(await git(resumed.workspace.repositoryPath, ['status', '--porcelain']), '')
})

test('acquire defers conflicting baseline synchronization and preserves the exact clean conversation branch', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  const first = await isolation.acquire(fixture.repository, 'window-a:chat-conflict')
  const originalBranch = first.workspace.branch
  const originalPath = first.workspace.repositoryPath
  await writeFile(join(first.workspace.projectPath, 'tracked.txt'), 'agent version\n')
  await first.release()

  await writeFile(join(fixture.repository, 'tracked.txt'), 'baseline version\n')
  await git(fixture.repository, ['add', 'tracked.txt'])
  await git(fixture.repository, ['commit', '-m', 'baseline change'])
  const baselineSha = await git(fixture.repository, ['rev-parse', 'HEAD'])

  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-conflict')
  context.after(() => resumed.release())
  assert.equal(resumed.workspace.branch, originalBranch)
  assert.equal(resumed.workspace.repositoryPath, originalPath)
  assert.equal(await readFile(join(resumed.workspace.projectPath, 'tracked.txt'), 'utf8'), 'agent version\n')
  assert.deepEqual(resumed.workspace.baselineConflict, {
    baselineSha,
    files: ['tracked.txt'],
    reason: 'New baseline changes conflict with this conversation’s work. Ensync preserved the clean conversation branch and will reconcile it before landing.',
  })
  const mergeHead = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
    cwd: resumed.workspace.repositoryPath,
  })
  assert.notEqual(mergeHead.exitCode, 0)
  assert.equal(await git(resumed.workspace.repositoryPath, ['diff', '--name-only', '--diff-filter=U']), '')
  assert.equal(await git(resumed.workspace.repositoryPath, ['status', '--porcelain']), '')
  assert.equal(resumed.workspace.integration.integrated, false)
})

test('commitAgentWork on a clean worktree commits nothing', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-clean')
  context.after(() => lease.release())

  const headBefore = await git(lease.workspace.repositoryPath, ['rev-parse', 'HEAD'])
  const result = await isolation.commitAgentWork(lease.workspace, { outcome: 'failed' })
  assert.equal(result.committed, false)
  assert.equal(result.changedFiles, 0)
  assert.equal(result.head, headBefore)
})

test('checkSharedCheckout reports user-style changes without attribution and reverts as destructive', async (context) => {
  const fixture = await repositoryFixture(context)
  await writeFile(join(fixture.repository, 'tracked.txt'), 'dirty before run\n')
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-detect')
  context.after(() => lease.release())

  // Unchanged.
  const same = await isolation.checkSharedCheckout(lease.workspace)
  assert.deepEqual({ available: same.available, changed: same.changed }, { available: true, changed: false })

  // Additive edit: changed, not destructive.
  await writeFile(join(fixture.repository, 'new-user-file.txt'), 'user typing during run\n')
  const edited = await isolation.checkSharedCheckout(lease.workspace)
  assert.equal(edited.changed, true)
  assert.equal(edited.destructive, false)

  // git checkout . shape: the pre-run dirty file reverts with no commit — destructive.
  await rm(join(fixture.repository, 'new-user-file.txt'))
  await git(fixture.repository, ['checkout', '--', 'tracked.txt'])
  const reverted = await isolation.checkSharedCheckout(lease.workspace)
  assert.equal(reverted.changed, true)
  assert.equal(reverted.destructive, true)
})

test('checkSharedCheckout treats an Ensync land commit as landed, not changed', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-detect-land')
  context.after(() => lease.release())

  await writeFile(join(fixture.repository, 'other-chat.txt'), 'landed content\n')
  await git(fixture.repository, ['add', 'other-chat.txt'])
  await git(fixture.repository, ['commit', '-m', 'Ensync land: ensync/chat-feedbeeffeedbeeffeedbeef'])

  const result = await isolation.checkSharedCheckout(lease.workspace)
  assert.equal(result.landed, true)
  assert.equal(result.changed, false)
})

test('checkSharedCheckout reports a landed commit plus a concurrent user edit as changed, landed, and not destructive', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-detect-land-mixed')
  context.after(() => lease.release())

  await writeFile(join(fixture.repository, 'other-chat.txt'), 'landed content\n')
  await git(fixture.repository, ['add', 'other-chat.txt'])
  await git(fixture.repository, ['commit', '-m', 'Ensync land: ensync/chat-feedbeeffeedbeeffeedbeef'])
  await writeFile(join(fixture.repository, 'concurrent-user-edit.txt'), 'typed during run\n')

  const result = await isolation.checkSharedCheckout(lease.workspace)
  assert.equal(result.changed, true)
  assert.equal(result.landed, true)
  assert.equal(result.destructive, false)
})

test('recoverStrandedWorktrees commits dirty stranded worktrees and skips active leases', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  const stranded = await isolation.acquire(fixture.repository, 'window-a:chat-stranded')
  await writeFile(join(stranded.workspace.projectPath, 'stranded.txt'), 'never committed\n')
  const strandedPath = stranded.workspace.repositoryPath
  await stranded.release()

  const active = await isolation.acquire(fixture.repository, 'window-a:chat-active')
  context.after(() => active.release())
  await writeFile(join(active.workspace.projectPath, 'active.txt'), 'in flight\n')

  const summary = await isolation.recoverStrandedWorktrees()
  assert.equal(summary.recovered.length, 1)
  assert.equal(summary.recovered[0].worktreePath, strandedPath)
  assert.equal(summary.recovered[0].changedFiles, 1)
  assert.ok(summary.skipped.some((entry) => entry.reason === 'active_lease'))
  const subject = await git(strandedPath, ['log', '-1', '--format=%s'])
  assert.equal(subject, 'Ensync agent work (recovered)')
  // The active worktree was not touched.
  assert.match(await git(active.workspace.repositoryPath, ['status', '--porcelain']), /active\.txt/)
})

test('a new conversation workspace is seeded from the fetched canonical remote base', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  const staleHead = await git(fixture.repository, ['rev-parse', 'HEAD'])
  const canonical = await fixture.publish('combined-offer.txt', 'rent and sale\n', 'combined offer')
  assert.notEqual(canonical, staleHead)

  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const acquired = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(acquired.workspace.gitBefore.head, canonical)
  assert.equal(acquired.workspace.base.sha, canonical)
  assert.equal(acquired.workspace.base.source, 'remote_default_branch')
  assert.equal(acquired.workspace.base.remote, 'origin')
  assert.equal(acquired.workspace.base.branch, 'main')
  assert.equal(
    await readFile(join(acquired.workspace.projectPath, 'combined-offer.txt'), 'utf8'),
    'rent and sale\n',
  )
  assert.equal(await git(fixture.repository, ['rev-parse', 'HEAD']), staleHead)
  await acquired.release()
})

test('uncommitted shared-checkout work is replayed on top of the refreshed canonical base', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  const canonical = await fixture.publish('combined-offer.txt', 'rent and sale\n', 'combined offer')
  await writeFile(join(fixture.repository, 'tracked.txt'), 'user edit\n')
  await writeFile(join(fixture.repository, 'untracked.txt'), 'user note\n')

  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const acquired = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(acquired.workspace.gitBefore.head, canonical)
  assert.equal(acquired.workspace.seededFromSharedCheckout, true)
  assert.equal(acquired.workspace.gitBefore.dirty, true)
  const workspacePath = acquired.workspace.projectPath
  assert.equal(await readFile(join(workspacePath, 'combined-offer.txt'), 'utf8'), 'rent and sale\n')
  assert.equal(await readFile(join(workspacePath, 'tracked.txt'), 'utf8'), 'user edit\n')
  assert.equal(await readFile(join(workspacePath, 'untracked.txt'), 'utf8'), 'user note\n')
  const changed = (await git(workspacePath, ['status', '--porcelain'])).split('\n').filter(Boolean)
  assert.equal(changed.length, 2)
  assert.equal(await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'), 'user edit\n')
  await acquired.release()
})

test('a resumed conversation worktree receives newly integrated canonical work', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot, baseFetchTtlMs: 0 })

  const first = await isolation.acquire(fixture.repository, 'window-a:chat-a')
  await writeFile(join(first.workspace.projectPath, 'agent-work.txt'), 'in progress\n')
  await first.release()

  const canonical = await fixture.publish('combined-offer.txt', 'rent and sale\n', 'combined offer')
  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(resumed.workspace.reused, true)
  assert.equal(resumed.workspace.base.sha, canonical)
  assert.equal(resumed.workspace.base.refreshed, true)
  assert.equal(
    await readFile(join(resumed.workspace.projectPath, 'combined-offer.txt'), 'utf8'),
    'rent and sale\n',
  )
  assert.equal(await readFile(join(resumed.workspace.projectPath, 'agent-work.txt'), 'utf8'), 'in progress\n')
  await resumed.release()
})

test('uncommitted work that conflicts with the canonical base is preserved on the local commit', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  const localHead = await git(fixture.repository, ['rev-parse', 'HEAD'])
  await fixture.publish('tracked.txt', 'canonical edit\n', 'canonical edit')
  await writeFile(join(fixture.repository, 'tracked.txt'), 'conflicting user edit\n')

  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const acquired = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(acquired.workspace.base.source, 'local_changes_conflict')
  assert.equal(acquired.workspace.base.sha, localHead)
  assert.equal(acquired.workspace.base.refreshed, false)
  assert.equal(acquired.workspace.gitBefore.head, localHead)
  assert.equal(
    await readFile(join(acquired.workspace.projectPath, 'tracked.txt'), 'utf8'),
    'conflicting user edit\n',
  )
  assert.equal(await git(acquired.workspace.repositoryPath, ['status', '--porcelain']), 'M tracked.txt')
  assert.equal(await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'), 'conflicting user edit\n')
  await acquired.release()
})

test('a resumed conversation keeps its own commits when the canonical base advances', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot, baseFetchTtlMs: 0 })
  const first = await isolation.acquire(fixture.repository, 'window-a:chat-a')
  const worktree = first.workspace.repositoryPath
  await writeFile(join(worktree, 'agent-work.txt'), 'agent commit\n')
  await git(worktree, ['add', 'agent-work.txt'])
  await git(worktree, ['commit', '-m', 'agent work'])
  await first.release()

  const canonical = await fixture.publish('combined-offer.txt', 'rent and sale\n', 'combined offer')
  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(resumed.workspace.base.refreshed, true)
  assert.equal(await readFile(join(worktree, 'combined-offer.txt'), 'utf8'), 'rent and sale\n')
  assert.equal(await readFile(join(worktree, 'agent-work.txt'), 'utf8'), 'agent commit\n')
  await git(worktree, ['merge-base', '--is-ancestor', canonical, 'HEAD'])
  assert.equal(resumed.workspace.integration.integrated, false)
  assert.equal(resumed.workspace.integration.unintegratedCommits > 0, true)
  await resumed.release()
})

test('a resumed conversation that conflicts with the canonical base is left untouched and reported', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot, baseFetchTtlMs: 0 })
  const first = await isolation.acquire(fixture.repository, 'window-a:chat-a')
  const worktree = first.workspace.repositoryPath
  await writeFile(join(worktree, 'tracked.txt'), 'agent version\n')
  await git(worktree, ['add', 'tracked.txt'])
  await git(worktree, ['commit', '-m', 'agent edit'])
  const agentHead = await git(worktree, ['rev-parse', 'HEAD'])
  await first.release()

  await fixture.publish('tracked.txt', 'canonical version\n', 'canonical edit')
  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(resumed.workspace.base.refreshed, false)
  assert.equal(resumed.workspace.base.source, 'base_refresh_deferred')
  assert.equal(resumed.workspace.base.sha, agentHead)
  assert.ok(resumed.workspace.base.reason)
  assert.equal(resumed.workspace.gitBefore.head, agentHead)
  assert.equal(await readFile(join(worktree, 'tracked.txt'), 'utf8'), 'agent version\n')
  assert.equal(await git(worktree, ['status', '--porcelain']), '')
  await resumed.release()
})

test('a divergent local history keeps the local base and reports the exact reason', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  await fixture.publish('combined-offer.txt', 'rent and sale\n', 'combined offer')
  await writeFile(join(fixture.repository, 'local-only.txt'), 'local work\n')
  await git(fixture.repository, ['add', 'local-only.txt'])
  await git(fixture.repository, ['commit', '-m', 'local only'])
  const localHead = await git(fixture.repository, ['rev-parse', 'HEAD'])

  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const acquired = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(acquired.workspace.base.source, 'divergent_local_history')
  assert.equal(acquired.workspace.base.sha, localHead)
  assert.equal(acquired.workspace.gitBefore.head, localHead)
  assert.match(acquired.workspace.base.reason, /diverged/i)
  await assert.rejects(readFile(join(acquired.workspace.projectPath, 'combined-offer.txt')), { code: 'ENOENT' })
  await acquired.release()
})

test('a local checkout ahead of the canonical branch keeps its own head', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  await writeFile(join(fixture.repository, 'local-only.txt'), 'local work\n')
  await git(fixture.repository, ['add', 'local-only.txt'])
  await git(fixture.repository, ['commit', '-m', 'local only'])
  const localHead = await git(fixture.repository, ['rev-parse', 'HEAD'])

  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const acquired = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(acquired.workspace.base.source, 'local_head_ahead')
  assert.equal(acquired.workspace.gitBefore.head, localHead)
  await acquired.release()
})

test('an unsafe configured remote never runs Git fetch and never blocks the run', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  await git(fixture.repository, ['remote', 'set-url', 'origin', 'ext::sh -c whoami'])
  const localHead = await git(fixture.repository, ['rev-parse', 'HEAD'])
  const attempted = []
  const isolation = new ProjectIsolationService({
    rootPath: fixture.workspaceRoot,
    gitRunner: (args, options) => {
      attempted.push(args[0])
      return runGit(args, options)
    },
  })

  const acquired = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(attempted.includes('fetch'), false)
  assert.equal(acquired.workspace.base.source, 'unsafe_remote')
  assert.equal(acquired.workspace.gitBefore.head, localHead)
  assert.match(acquired.workspace.base.reason, /unsupported/i)
  await acquired.release()
})

test('an unreachable canonical remote reports the failure and still starts the workspace', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  const localHead = await git(fixture.repository, ['rev-parse', 'HEAD'])
  await rm(fixture.remote, { recursive: true, force: true })

  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const acquired = await isolation.acquire(fixture.repository, 'window-a:chat-a')

  assert.equal(acquired.workspace.base.source, 'stale_remote_ref')
  assert.equal(acquired.workspace.gitBefore.head, localHead)
  assert.ok(acquired.workspace.base.reason)
  await acquired.release()
})

test('concurrent conversations in one repository share a single canonical fetch', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  await fixture.publish('combined-offer.txt', 'rent and sale\n', 'combined offer')
  let fetches = 0
  const gitRunner = (args, options) => {
    if (args[0] === 'fetch') fetches += 1
    return runGit(args, options)
  }
  const first = new ProjectIsolationService({ rootPath: join(fixture.root, 'host-a'), gitRunner, lockPollMs: 10 })
  const second = new ProjectIsolationService({ rootPath: join(fixture.root, 'host-b'), gitRunner, lockPollMs: 10 })

  const [a, b] = await Promise.all([
    first.acquire(fixture.repository, 'window-a:chat-a'),
    second.acquire(fixture.repository, 'window-b:chat-b'),
  ])

  assert.equal(fetches, 1)
  assert.equal(a.workspace.base.sha, b.workspace.base.sha)
  assert.equal(await readFile(join(a.workspace.projectPath, 'combined-offer.txt'), 'utf8'), 'rent and sale\n')
  assert.equal(await readFile(join(b.workspace.projectPath, 'combined-offer.txt'), 'utf8'), 'rent and sale\n')
  await a.release()
  await b.release()
})

test('a chat branch reports how much of its work is not yet contained in the canonical base', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot, baseFetchTtlMs: 0 })

  const first = await isolation.acquire(fixture.repository, 'window-a:chat-a')
  assert.equal(first.workspace.integration.integrated, true)
  assert.equal(first.workspace.integration.unintegratedCommits, 0)
  const workspacePath = first.workspace.repositoryPath
  await writeFile(join(workspacePath, 'agent-work.txt'), 'finished\n')
  await git(workspacePath, ['add', 'agent-work.txt'])
  await git(workspacePath, ['commit', '-m', 'agent work'])
  await first.release()

  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-a')
  assert.equal(resumed.workspace.integration.integrated, false)
  assert.equal(resumed.workspace.integration.unintegratedCommits, 1)
  await resumed.release()
})

test('ChatRunService reports the canonical base to the user and the provider', async (context) => {
  const fixture = await remoteRepositoryFixture(context)
  const canonical = await fixture.publish('combined-offer.txt', 'rent and sale\n', 'combined offer')
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const events = []
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
      providerPrompt = options.input
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
    },
  })

  const result = await service.run({
    provider: 'claude',
    projectPath: fixture.repository,
    workspaceKey: 'window-a:chat-a',
    prompt: 'Continue the combined offer work',
  }, { onEvent: (event) => events.push(event) })

  const ready = events.find((event) => event.code === 'project_workspace_ready')
  assert.equal(ready.workspace.base.sha, canonical)
  assert.equal(ready.workspace.base.source, 'remote_default_branch')
  assert.match(ready.message, /origin\/main/)
  assert.equal(result.workspace.base.sha, canonical)
  assert.match(providerPrompt, new RegExp(`Base: origin/main at ${canonical}`))
})

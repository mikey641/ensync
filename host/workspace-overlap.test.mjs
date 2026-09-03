import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runGit } from './git.mjs'
import { WorkspaceOverlapMonitor } from './workspace-overlap.mjs'

const FIRST_BRANCH = 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa'
const SECOND_BRANCH = 'ensync/chat-bbbbbbbbbbbbbbbbbbbbbbbb'

async function git(cwd, args) {
  const result = await runGit(args, { cwd })
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-overlap-test-'))
  const repository = join(root, 'repository')
  const firstPath = join(root, 'first')
  const secondPath = join(root, 'second')
  await mkdir(join(repository, 'src'), { recursive: true })
  await git(repository, ['init', '-b', 'main'])
  await git(repository, ['config', 'user.name', 'Test User'])
  await git(repository, ['config', 'user.email', 'test@example.com'])
  await writeFile(join(repository, 'src', 'a.ts'), 'base a\n')
  await writeFile(join(repository, 'src', 'b.ts'), 'base b\n')
  await git(repository, ['add', '.'])
  await git(repository, ['commit', '-m', 'initial'])
  await git(repository, ['branch', FIRST_BRANCH])
  await git(repository, ['branch', SECOND_BRANCH])
  await git(repository, ['worktree', 'add', firstPath, FIRST_BRANCH])
  await git(repository, ['worktree', 'add', secondPath, SECOND_BRANCH])
  const commonGitDirectory = await git(repository, ['rev-parse', '--absolute-git-dir'])
  context.after(() => rm(root, { recursive: true, force: true }))
  return {
    root,
    repository,
    commonGitDirectory,
    first: {
      repositoryPath: firstPath,
      projectPath: firstPath,
      commonGitDirectory,
      branch: FIRST_BRANCH,
      shared: { repositoryPath: repository },
    },
    second: {
      repositoryPath: secondPath,
      projectPath: secondPath,
      commonGitDirectory,
      branch: SECOND_BRANCH,
      shared: { repositoryPath: repository },
    },
  }
}

function detected(events) {
  return events.filter((event) => event.code === 'workspace_file_overlap_detected')
}

test('slow polling coalesces repeated ticks into one trailing overlap refresh', async (context) => {
  const f = await fixture(context)
  let tick = null
  let blockRefreshes = false
  let refreshStatusCalls = 0
  const firstRefreshStarted = deferred()
  const releaseFirstRefresh = deferred()
  const monitor = new WorkspaceOverlapMonitor({
    pollMs: 1,
    setInterval: (callback) => {
      tick = callback
      return { unref() {} }
    },
    clearInterval: () => {},
    gitRunner: async (args, options) => {
      if (blockRefreshes && options.cwd === f.first.repositoryPath && args[0] === 'status') {
        refreshStatusCalls += 1
        if (refreshStatusCalls === 1) {
          firstRefreshStarted.resolve()
          await releaseFirstRefresh.promise
        }
      }
      return runGit(args, options)
    },
  })
  const session = await monitor.start(f.first, { jobId: 'job-coalesced-refresh' })
  context.after(() => session.stop())
  blockRefreshes = true

  tick()
  await firstRefreshStarted.promise
  for (let index = 0; index < 50; index += 1) tick()
  const finalRefresh = session.refresh()
  releaseFirstRefresh.resolve()
  await finalRefresh

  assert.equal(refreshStatusCalls, 2)
})

test('ticks during the trailing scan cannot extend one overlap refresh operation', async (context) => {
  const f = await fixture(context)
  let tick = null
  let blockRefreshes = false
  let refreshStatusCalls = 0
  const firstRefreshStarted = deferred()
  const releaseFirstRefresh = deferred()
  const trailingRefreshStarted = deferred()
  const releaseTrailingRefresh = deferred()
  const monitor = new WorkspaceOverlapMonitor({
    pollMs: 1,
    setInterval: (callback) => {
      tick = callback
      return { unref() {} }
    },
    clearInterval: () => {},
    gitRunner: async (args, options) => {
      if (blockRefreshes && options.cwd === f.first.repositoryPath && args[0] === 'status') {
        refreshStatusCalls += 1
        if (refreshStatusCalls === 1) {
          firstRefreshStarted.resolve()
          await releaseFirstRefresh.promise
        } else if (refreshStatusCalls === 2) {
          trailingRefreshStarted.resolve()
          await releaseTrailingRefresh.promise
        }
      }
      return runGit(args, options)
    },
  })
  const session = await monitor.start(f.first, { jobId: 'job-bounded-trailing-refresh' })
  context.after(() => session.stop())
  blockRefreshes = true

  tick()
  await firstRefreshStarted.promise
  for (let index = 0; index < 50; index += 1) tick()
  const sharedRefresh = session.refresh()
  releaseFirstRefresh.resolve()
  await trailingRefreshStarted.promise
  for (let index = 0; index < 50; index += 1) tick()
  session.refresh()
  releaseTrailingRefresh.resolve()
  await sharedRefresh

  assert.equal(refreshStatusCalls, 2)
})

test('a failed active scan still consumes its coalesced trailing refresh', async (context) => {
  const f = await fixture(context)
  let tick = null
  let failRefreshes = false
  let refreshStatusCalls = 0
  const firstRefreshStarted = deferred()
  const releaseFirstRefresh = deferred()
  const events = []
  const monitor = new WorkspaceOverlapMonitor({
    pollMs: 1,
    setInterval: (callback) => {
      tick = callback
      return { unref() {} }
    },
    clearInterval: () => {},
    gitRunner: async (args, options) => {
      if (failRefreshes && options.cwd === f.first.repositoryPath && args[0] === 'status') {
        refreshStatusCalls += 1
        if (refreshStatusCalls === 1) {
          firstRefreshStarted.resolve()
          await releaseFirstRefresh.promise
          throw new Error('planned overlap refresh failure')
        }
      }
      return runGit(args, options)
    },
  })
  const session = await monitor.start(f.first, {
    jobId: 'job-retried-refresh-failure',
    onEvent: (event) => events.push(event),
  })
  context.after(() => session.stop())
  failRefreshes = true

  tick()
  await firstRefreshStarted.promise
  const sharedRefresh = session.refresh()
  releaseFirstRefresh.resolve()
  await sharedRefresh

  assert.equal(refreshStatusCalls, 2)
  assert.equal(events.filter((event) => event.code === 'workspace_overlap_unavailable').length, 1)
})

test('stopping a slow overlap session suppresses trailing refreshes and removes its record', async (context) => {
  const f = await fixture(context)
  let tick = null
  let blockRefreshes = false
  let refreshStatusCalls = 0
  const firstRefreshStarted = deferred()
  const releaseFirstRefresh = deferred()
  const monitor = new WorkspaceOverlapMonitor({
    pollMs: 1,
    setInterval: (callback) => {
      tick = callback
      return { unref() {} }
    },
    clearInterval: () => {},
    gitRunner: async (args, options) => {
      if (blockRefreshes && options.cwd === f.first.repositoryPath && args[0] === 'status') {
        refreshStatusCalls += 1
        if (refreshStatusCalls === 1) {
          firstRefreshStarted.resolve()
          await releaseFirstRefresh.promise
        }
      }
      return runGit(args, options)
    },
  })
  const session = await monitor.start(f.first, { jobId: 'job-stopped-refresh' })
  blockRefreshes = true
  tick()
  await firstRefreshStarted.promise
  for (let index = 0; index < 50; index += 1) tick()

  const stopped = session.stop()
  releaseFirstRefresh.resolve()
  await stopped

  assert.equal(refreshStatusCalls, 1)
  const recordPath = join(f.commonGitDirectory, 'ensync', 'active-workspace-edits', 'aaaaaaaaaaaaaaaaaaaaaaaa.json')
  await assert.rejects(readFile(recordPath, 'utf8'), (error) => error?.code === 'ENOENT')
})

test('active conversations warn only after changing the exact same file', async (context) => {
  const f = await fixture(context)
  const monitor = new WorkspaceOverlapMonitor({ pollMs: 60_000 })
  const firstEvents = []
  const secondEvents = []
  const first = await monitor.start(f.first, { jobId: 'job-first-active', onEvent: (event) => firstEvents.push(event) })
  const second = await monitor.start(f.second, { jobId: 'job-second-active', onEvent: (event) => secondEvents.push(event) })
  context.after(() => Promise.all([first.stop(), second.stop()]))

  await writeFile(join(f.first.repositoryPath, 'src', 'a.ts'), 'first edit\n')
  await writeFile(join(f.second.repositoryPath, 'src', 'b.ts'), 'second edit\n')
  await first.refresh()
  await second.refresh()
  await first.refresh()
  assert.deepEqual(detected(firstEvents), [])
  assert.deepEqual(detected(secondEvents), [])

  await writeFile(join(f.second.repositoryPath, 'src', 'a.ts'), 'second overlapping edit\n')
  await second.refresh()
  await first.refresh()

  assert.deepEqual(detected(firstEvents).at(-1).overlap, {
    peerBranch: SECOND_BRANCH,
    state: 'detected',
    source: 'active',
    paths: ['src/a.ts'],
    totalCount: 1,
  })
  assert.deepEqual(detected(secondEvents).at(-1).overlap.paths, ['src/a.ts'])
})

test('a file dirty before admission warns only after this run changes its content', async (context) => {
  const f = await fixture(context)
  await writeFile(join(f.first.repositoryPath, 'src', 'a.ts'), 'dirty before first run\n')
  await writeFile(join(f.second.repositoryPath, 'src', 'a.ts'), 'dirty before second run\n')
  const monitor = new WorkspaceOverlapMonitor({ pollMs: 60_000 })
  const firstEvents = []
  const secondEvents = []
  const first = await monitor.start(f.first, { jobId: 'job-first-dirty', onEvent: (event) => firstEvents.push(event) })
  const second = await monitor.start(f.second, { jobId: 'job-second-dirty', onEvent: (event) => secondEvents.push(event) })
  context.after(() => Promise.all([first.stop(), second.stop()]))

  await first.refresh()
  await second.refresh()
  assert.deepEqual(detected(firstEvents), [])
  assert.deepEqual(detected(secondEvents), [])

  await writeFile(join(f.first.repositoryPath, 'src', 'a.ts'), 'changed during first run\n')
  await writeFile(join(f.second.repositoryPath, 'src', 'a.ts'), 'changed during second run\n')
  await first.refresh()
  await second.refresh()
  await first.refresh()
  assert.deepEqual(detected(firstEvents).at(-1).overlap.paths, ['src/a.ts'])
})

test('overlap transitions are deduplicated and clear when a peer stops changing the path', async (context) => {
  const f = await fixture(context)
  const monitor = new WorkspaceOverlapMonitor({ pollMs: 60_000 })
  const events = []
  const first = await monitor.start(f.first, { jobId: 'job-first-clear', onEvent: (event) => events.push(event) })
  const second = await monitor.start(f.second, { jobId: 'job-second-clear' })
  context.after(() => Promise.all([first.stop(), second.stop()]))
  await writeFile(join(f.first.repositoryPath, 'src', 'a.ts'), 'first\n')
  await writeFile(join(f.second.repositoryPath, 'src', 'a.ts'), 'second\n')
  await first.refresh()
  await second.refresh()
  await first.refresh()
  await first.refresh()
  assert.equal(detected(events).length, 1)

  await second.stop()
  await first.refresh()
  const cleared = events.filter((event) => event.code === 'workspace_file_overlap_cleared')
  assert.equal(cleared.length, 1)
  assert.equal(cleared[0].overlap.peerBranch, SECOND_BRANCH)
  assert.equal(cleared[0].overlap.state, 'cleared')
})

test('malformed and stale activity records are ignored and owned records are removed', async (context) => {
  const f = await fixture(context)
  let now = Date.parse('2026-08-12T00:00:00.000Z')
  const monitor = new WorkspaceOverlapMonitor({ pollMs: 60_000, staleMs: 5_000, now: () => now })
  const session = await monitor.start(f.first, { jobId: 'job-record-cleanup' })
  await writeFile(join(f.first.repositoryPath, 'src', 'a.ts'), 'changed\n')
  await session.refresh()

  const recordsDirectory = join(f.commonGitDirectory, 'ensync', 'active-workspace-edits')
  const ownedRecord = join(recordsDirectory, 'aaaaaaaaaaaaaaaaaaaaaaaa.json')
  const record = JSON.parse(await readFile(ownedRecord, 'utf8'))
  assert.deepEqual(record.paths, ['src/a.ts'])

  await writeFile(join(recordsDirectory, 'malformed.json'), '{not json')
  await writeFile(join(recordsDirectory, 'stale.json'), JSON.stringify({
    schemaVersion: 1,
    token: 'stale-token',
    jobId: 'stale-job',
    branch: SECOND_BRANCH,
    updatedAt: new Date(now - 10_000).toISOString(),
    paths: ['src/a.ts'],
  }))
  now += 1_000
  assert.deepEqual(await session.refresh(), [])

  await session.stop()
  await assert.rejects(readFile(ownedRecord, 'utf8'), (error) => error?.code === 'ENOENT')
})

test('completed unlanded branches participate in preflight overlap inspection', async (context) => {
  const f = await fixture(context)
  await writeFile(join(f.first.repositoryPath, 'src', 'a.ts'), 'first committed edit\n')
  await git(f.first.repositoryPath, ['add', 'src/a.ts'])
  await git(f.first.repositoryPath, ['commit', '-m', 'first work'])
  await writeFile(join(f.second.repositoryPath, 'src', 'a.ts'), 'second committed edit\n')
  await git(f.second.repositoryPath, ['add', 'src/a.ts'])
  await git(f.second.repositoryPath, ['commit', '-m', 'second work'])

  const monitor = new WorkspaceOverlapMonitor({ pollMs: 60_000 })
  const overlaps = await monitor.inspect(f.first)
  assert.deepEqual(overlaps, [{
    peerBranch: SECOND_BRANCH,
    source: 'unlanded',
    paths: ['src/a.ts'],
    totalCount: 1,
  }])
})

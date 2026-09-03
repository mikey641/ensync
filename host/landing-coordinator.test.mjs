import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { anchorLandingSnapshot, LandingCoordinator } from './landing-coordinator.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const execFileAsync = promisify(execFile)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function input(branch, repositoryPath = '/repo', savedSha = SHA_A) {
  return {
    repositoryPath,
    commonGitDirectory: `${repositoryPath}/.git`,
    projectPath: repositoryPath,
    workspacePath: `/worktrees/${branch.replaceAll('/', '-')}`,
    branch,
    savedSha,
    targetBranch: 'main',
    targetBaseSha: SHA_A,
    provider: 'codex',
  }
}

class MemoryJournal {
  constructor(items = []) {
    this.items = items.map((item) => ({ ...item }))
    this.sequence = this.items.reduce((maximum, item) => Math.max(maximum, item.completionSequence), 0)
  }

  async load() {
    return this.items.map((item) => ({ ...item }))
  }

  async anchorSnapshot() {}

  async releaseSnapshot() {}

  async enqueue(value) {
    const sequence = ++this.sequence
    const item = {
      ...value,
      id: `landing-${sequence}`,
      completionSequence: sequence,
      state: 'queued',
      attempts: 0,
      createdAt: `2026-09-03T00:00:0${sequence}.000Z`,
      updatedAt: `2026-09-03T00:00:0${sequence}.000Z`,
      error: null,
    }
    this.items.push(item)
    return { ...item }
  }

  async transition(id, expectedState, nextState, patch = {}) {
    const item = this.items.find((candidate) => candidate.id === id)
    if (!item || item.state !== expectedState) return null
    Object.assign(item, {
      state: nextState,
      ...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
      ...(patch.error === undefined ? {} : { error: patch.error }),
    })
    return { ...item }
  }
}

test('enqueue resolves and an idle repository starts integration on a microtask', async () => {
  const started = deferred()
  const neverFinishes = deferred()
  const journal = new MemoryJournal()
  const coordinator = new LandingCoordinator({
    journal,
    persistenceRetryDelays: [1],
    integrate: async (train) => {
      started.resolve(train)
      return neverFinishes.promise
    },
  })

  const item = await coordinator.enqueue(input('ensync/first'))
  const train = await started.promise

  assert.equal(item.state, 'queued')
  assert.deepEqual(train.map((entry) => entry.id), [item.id])
  assert.equal(journal.items[0].state, 'integrating')
})

test('enqueue anchors the exact commit in Git before the journal accepts it', async (context) => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'ensync-landing-anchor-'))
  context.after(() => rm(repositoryPath, { recursive: true, force: true }))
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repositoryPath })
  await execFileAsync('git', ['config', 'user.name', 'Ensync Test'], { cwd: repositoryPath })
  await execFileAsync('git', ['config', 'user.email', 'ensync@example.test'], { cwd: repositoryPath })
  await writeFile(join(repositoryPath, 'README.md'), 'base\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repositoryPath })
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repositoryPath })
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath })
  const savedSha = stdout.trim()
  const marker = join(repositoryPath, '..', `anchor-hook-${savedSha.slice(0, 8)}`)
  context.after(() => rm(marker, { force: true }))
  await mkdir(join(repositoryPath, '.githooks'))
  const hook = join(repositoryPath, '.githooks', 'reference-transaction')
  await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`)
  await chmod(hook, 0o755)
  await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repositoryPath })
  const order = []
  const journal = new MemoryJournal()
  const originalEnqueue = journal.enqueue.bind(journal)
  journal.enqueue = async (value) => {
    order.push('journal')
    return originalEnqueue(value)
  }
  const coordinator = new LandingCoordinator({
    journal,
    anchorSnapshot: async (value) => {
      await anchorLandingSnapshot(value)
      order.push('anchor')
    },
    integrate: async () => new Promise(() => {}),
  })

  await coordinator.enqueue(input('ensync/anchored', repositoryPath, savedSha))
  const anchored = await execFileAsync(
    'git',
    ['rev-parse', `refs/ensync/landing-snapshots/${savedSha}`],
    { cwd: repositoryPath },
  )

  assert.deepEqual(order, ['anchor', 'journal'])
  assert.equal(anchored.stdout.trim(), savedSha)
  await assert.rejects(readFile(marker, 'utf8'), (error) => error?.code === 'ENOENT')
})

test('snapshot anchors use the repository object ID width for SHA-256 commits', async () => {
  const savedSha = 'a'.repeat(64)
  const calls = []
  await anchorLandingSnapshot({ repositoryPath: '/repo', savedSha }, {
    gitRunner: async (args) => {
      calls.push(args)
      if (args.includes('rev-parse')) return { exitCode: 1, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })

  const update = calls.find((args) => args.includes('update-ref'))
  assert.equal(update.at(-1), '0'.repeat(64))
})

test('completion sequence controls FIFO and arrivals during a train form the next train', async () => {
  const firstTrain = deferred()
  const calls = []
  const journal = new MemoryJournal()
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async (train) => {
      calls.push(train.map((item) => item.branch))
      if (calls.length === 1) return firstTrain.promise
      return { landedIds: train.map((item) => item.id), retryIds: [] }
    },
  })

  const first = await coordinator.enqueue(input('ensync/first'))
  await Promise.resolve()
  const [second, third] = await Promise.all([
    coordinator.enqueue(input('ensync/second', '/repo', SHA_B)),
    coordinator.enqueue(input('ensync/third', '/repo', SHA_C)),
  ])
  firstTrain.resolve({ landedIds: [first.id], retryIds: [] })
  await coordinator.whenIdle()

  assert.deepEqual(calls, [
    ['ensync/first'],
    ['ensync/second', 'ensync/third'],
  ])
  assert.deepEqual(
    journal.items.map((item) => [item.id, item.completionSequence, item.state]),
    [
      [first.id, 1, 'landed'],
      [second.id, 2, 'landed'],
      [third.id, 3, 'landed'],
    ],
  )
})

test('enqueue invocation order survives a slower first snapshot anchor', async () => {
  const firstAnchor = deferred()
  const journal = new MemoryJournal()
  const coordinator = new LandingCoordinator({
    journal,
    anchorSnapshot: async (value) => {
      if (value.branch === 'ensync/first') await firstAnchor.promise
    },
    integrate: async (train) => ({ landedIds: train.map((item) => item.id), retryIds: [] }),
  })

  const firstPromise = coordinator.enqueue(input('ensync/first'))
  const secondPromise = coordinator.enqueue(input('ensync/second', '/repo', SHA_B))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(journal.items, [])

  firstAnchor.resolve()
  const [first, second] = await Promise.all([firstPromise, secondPromise])
  await coordinator.whenIdle()
  assert.equal(first.completionSequence, 1)
  assert.equal(second.completionSequence, 2)
})

test('linked checkouts sharing one Git directory use one FIFO train', async () => {
  const firstTrain = deferred()
  const trains = []
  const journal = new MemoryJournal()
  const commonGitDirectory = '/shared/repository.git'
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async (train) => {
      trains.push(train.map((item) => item.branch))
      if (trains.length === 1) return firstTrain.promise
      return { landedIds: train.map((item) => item.id), retryIds: [] }
    },
  })

  const first = await coordinator.enqueue({
    ...input('ensync/first-linked', '/checkout/one'),
    commonGitDirectory,
  })
  await Promise.resolve()
  await coordinator.enqueue({
    ...input('ensync/second-linked', '/checkout/two', SHA_B),
    commonGitDirectory,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(trains, [['ensync/first-linked']])

  firstTrain.resolve({ landedIds: [first.id], retryIds: [] })
  await coordinator.whenIdle()
  assert.deepEqual(trains, [
    ['ensync/first-linked'],
    ['ensync/second-linked'],
  ])
})

test('different repositories integrate concurrently', async () => {
  const repoABlocked = deferred()
  const repoAStarted = deferred()
  const journal = new MemoryJournal()
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async (train) => {
      if (train[0].repositoryPath === '/repo-a') {
        repoAStarted.resolve()
        return repoABlocked.promise
      }
      return { landedIds: train.map((item) => item.id), retryIds: [] }
    },
  })

  const itemA = await coordinator.enqueue(input('ensync/a', '/repo-a'))
  await repoAStarted.promise
  const itemB = await coordinator.enqueue(input('ensync/b', '/repo-b', SHA_B))
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(journal.items.find((item) => item.id === itemA.id).state, 'integrating')
  assert.equal(journal.items.find((item) => item.id === itemB.id).state, 'landed')
  repoABlocked.resolve({ landedIds: [itemA.id], retryIds: [] })
  await coordinator.whenIdle()
})

test('one repository never mixes different target branches in the same train', async () => {
  const journal = new MemoryJournal()
  const calls = []
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async (train) => {
      calls.push(train.map((item) => `${item.targetBranch}:${item.branch}`))
      return { landedIds: train.map((item) => item.id), retryIds: [] }
    },
  })

  await Promise.all([
    coordinator.enqueue(input('ensync/main-one')),
    coordinator.enqueue({ ...input('ensync/release-one', '/repo', SHA_B), targetBranch: 'release' }),
    coordinator.enqueue(input('ensync/main-two', '/repo', SHA_C)),
  ])
  await coordinator.whenIdle()

  assert.deepEqual(calls, [
    ['main:ensync/main-one'],
    ['release:ensync/release-one'],
    ['main:ensync/main-two'],
  ])
})

test('a one-shot journal transition failure is recovered without a Host restart', async () => {
  const journal = new MemoryJournal()
  const originalTransition = journal.transition.bind(journal)
  let failuresRemaining = 1
  journal.transition = async (...args) => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      throw new Error('simulated journal write failure')
    }
    return originalTransition(...args)
  }
  const calls = []
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async (train) => {
      calls.push(train.map((item) => item.id))
      return { landedIds: train.map((item) => item.id), retryIds: [] }
    },
  })

  const queued = await coordinator.enqueue(input('ensync/recovered'))
  await coordinator.whenIdle()

  assert.deepEqual(calls, [[queued.id]])
  assert.equal(journal.items[0].state, 'landed')
})

test('a failed terminal journal write is recovered and reaches a durable terminal state', async () => {
  const journal = new MemoryJournal()
  const originalTransition = journal.transition.bind(journal)
  let failedTerminalWrite = false
  journal.transition = async (id, expected, next, patch) => {
    if (!failedTerminalWrite && expected === 'integrating' && next === 'landed') {
      failedTerminalWrite = true
      throw new Error('simulated terminal write failure')
    }
    return originalTransition(id, expected, next, patch)
  }
  let integrationCalls = 0
  const coordinator = new LandingCoordinator({
    journal,
    persistenceRetryDelays: [1],
    integrate: async (train) => {
      integrationCalls += 1
      return { landedIds: train.map((item) => item.id), retryIds: [] }
    },
  })

  await coordinator.enqueue(input('ensync/recovered-terminal'))
  await coordinator.whenIdle()

  assert.equal(journal.items[0].state, 'landed')
  assert.equal(integrationCalls, 2)
})

test('persistent journal failures stop after bounded retries until a new enqueue signal', async () => {
  const journal = new MemoryJournal()
  let transitionCalls = 0
  journal.transition = async () => {
    transitionCalls += 1
    throw new Error('storage remains unavailable')
  }
  const coordinator = new LandingCoordinator({
    journal,
    persistenceRetryDelays: [1, 1],
    integrate: async () => {
      throw new Error('integration must not start without a durable transition')
    },
  })

  await coordinator.enqueue(input('ensync/persistent-storage-error'))
  await coordinator.whenIdle()

  assert.equal(transitionCalls, 3)
  assert.equal(coordinator.hasActiveWork(), false)
})

test('one rejected item enters retry without blocking compatible items', async () => {
  const journal = new MemoryJournal()
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async (train) => ({
      landedIds: [train[1].id],
      retryIds: [train[0].id],
      errors: { [train[0].id]: 'conflict remains' },
    }),
  })

  const [conflicting, compatible] = await Promise.all([
    coordinator.enqueue(input('ensync/conflict')),
    coordinator.enqueue(input('ensync/compatible', '/repo', SHA_B)),
  ])
  await coordinator.whenIdle()

  assert.equal(journal.items.find((item) => item.id === conflicting.id).state, 'retry')
  assert.equal(journal.items.find((item) => item.id === conflicting.id).error, 'conflict remains')
  assert.equal(journal.items.find((item) => item.id === compatible.id).state, 'landed')
})

test('integration rejection becomes retry state without an unhandled background rejection', async () => {
  const journal = new MemoryJournal()
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async () => { throw new Error(`failure ${'x'.repeat(10_000)}`) },
  })

  const item = await coordinator.enqueue(input('ensync/failure'))
  await coordinator.whenIdle()
  const stored = journal.items.find((candidate) => candidate.id === item.id)

  assert.equal(stored.state, 'retry')
  assert.match(stored.error, /^failure x/)
  assert.ok(stored.error.length <= 4_096)
})

test('a new completion automatically retrains older retry items without blocking the newcomer', async () => {
  const journal = new MemoryJournal()
  const calls = []
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async (train) => {
      calls.push(train.map((item) => item.branch))
      if (calls.length === 1) {
        return { landedIds: [], retryIds: [train[0].id] }
      }
      return { landedIds: train.map((item) => item.id), retryIds: [] }
    },
  })

  await coordinator.enqueue(input('ensync/retry-first'))
  await coordinator.whenIdle()
  await coordinator.enqueue(input('ensync/new-completion', '/repo', SHA_B))
  await coordinator.whenIdle()

  assert.deepEqual(calls, [
    ['ensync/retry-first'],
    ['ensync/retry-first', 'ensync/new-completion'],
  ])
  assert.ok(journal.items.every((item) => item.state === 'landed'))
})

test('start resumes queued and retry entries once even when called repeatedly', async () => {
  const recovered = [
    {
      ...input('ensync/queued'),
      id: 'landing-1',
      completionSequence: 1,
      state: 'queued',
      attempts: 0,
      createdAt: '2026-09-03T00:00:01.000Z',
      updatedAt: '2026-09-03T00:00:01.000Z',
      error: null,
    },
    {
      ...input('ensync/retry', '/repo', SHA_B),
      id: 'landing-2',
      completionSequence: 2,
      state: 'retry',
      attempts: 1,
      createdAt: '2026-09-03T00:00:02.000Z',
      updatedAt: '2026-09-03T00:00:02.000Z',
      error: 'previous conflict',
    },
  ]
  const journal = new MemoryJournal(recovered)
  const calls = []
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async (train) => {
      calls.push(train.map((item) => item.id))
      return { landedIds: train.map((item) => item.id), retryIds: [] }
    },
  })

  await Promise.all([coordinator.start(), coordinator.start()])
  await coordinator.whenIdle()

  assert.deepEqual(calls, [['landing-1', 'landing-2']])
  assert.ok(journal.items.every((item) => item.state === 'landed'))
})

test('shutdown aborts the active train, waits for it to settle, and leaves the item durable for restart', async () => {
  const integrationStarted = deferred()
  const integrationClosed = deferred()
  const journal = new MemoryJournal()
  const coordinator = new LandingCoordinator({
    journal,
    integrate: async (train, options) => {
      integrationStarted.resolve(options.signal)
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
      integrationClosed.resolve()
      return {
        landedIds: [],
        retryIds: train.map((item) => item.id),
        errors: Object.fromEntries(train.map((item) => [item.id, 'Host stopped during integration.'])),
      }
    },
  })

  const item = await coordinator.enqueue(input('ensync/shutdown'))
  const signal = await integrationStarted.promise
  const stopped = coordinator.shutdown()

  assert.equal(signal.aborted, true)
  await integrationClosed.promise
  await stopped
  assert.equal(coordinator.hasActiveWork(), false)
  assert.equal(journal.items.find((candidate) => candidate.id === item.id).state, 'retry')
})

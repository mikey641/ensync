import assert from 'node:assert/strict'
import test from 'node:test'

import { LandingCoordinator } from './landing-coordinator.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

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
    projectPath: repositoryPath,
    workspacePath: `/worktrees/${branch.replaceAll('/', '-')}`,
    branch,
    savedSha,
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

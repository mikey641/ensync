import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LandingJournal } from './landing-journal.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

function landingInput(overrides = {}) {
  return {
    repositoryPath: '/projects/repository',
    commonGitDirectory: '/projects/repository/.git',
    projectPath: '/projects/repository/app',
    workspacePath: '/worktrees/chat-one/app',
    branch: 'ensync/chat-one',
    savedSha: SHA_A,
    targetBranch: 'main',
    targetBaseSha: SHA_B,
    provider: 'codex',
    ...overrides,
  }
}

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-landing-journal-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'landing-journal.json')
  return { directory, filePath, journal: new LandingJournal({ filePath }) }
}

function rechecksum(envelope) {
  envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex')
  return JSON.stringify(envelope)
}

test('journal fails closed on a corrupt checksum instead of dropping queued state', async (context) => {
  const { filePath, journal } = await fixture(context)
  await journal.enqueue(landingInput())
  const encoded = await readFile(filePath, 'utf8')
  await writeFile(filePath, encoded.replace(SHA_A, SHA_B))

  await assert.rejects(
    new LandingJournal({ filePath }).load(),
    /journal.*corrupt|corrupt.*journal/i,
  )
})

test('a failed enqueue never leaks into a later successful journal write', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-landing-journal-failed-enqueue-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const parent = join(root, 'blocked')
  const filePath = join(parent, 'landing-journal.json')
  await writeFile(parent, 'not a directory')
  const journal = new LandingJournal({ filePath })

  await assert.rejects(journal.enqueue(landingInput({ branch: 'ensync/rejected' })))
  await rm(parent)
  const accepted = await journal.enqueue(landingInput({ branch: 'ensync/accepted' }))
  const stored = await new LandingJournal({ filePath }).load()

  assert.equal(accepted.completionSequence, 1)
  assert.deepEqual(stored.map((item) => item.branch), ['ensync/accepted'])
})

test('a failed transition leaves the in-memory item in its durable prior state', async (context) => {
  const { directory, journal } = await fixture(context)
  const queued = await journal.enqueue(landingInput())
  await rm(directory, { recursive: true, force: true })
  await writeFile(directory, 'not a directory')

  await assert.rejects(journal.transition(queued.id, 'queued', 'integrating', { attempts: 1 }))
  const retained = await journal.load()

  assert.equal(retained[0].state, 'queued')
  assert.equal(retained[0].attempts, 0)
})

test('journal recovers the newest valid staging write', async (context) => {
  const { filePath, journal } = await fixture(context)
  await journal.enqueue(landingInput())
  await journal.enqueue(landingInput({ branch: 'ensync/chat-two', savedSha: SHA_B }))
  const newest = await readFile(filePath, 'utf8')
  await writeFile(`${filePath}.staging`, newest)
  await writeFile(filePath, '{"interrupted":true}')

  const recovered = await new LandingJournal({ filePath }).load()

  assert.deepEqual(recovered.map((item) => item.branch), ['ensync/chat-one', 'ensync/chat-two'])
  assert.deepEqual(
    (await new LandingJournal({ filePath }).load()).map((item) => item.branch),
    ['ensync/chat-one', 'ensync/chat-two'],
  )
})

test('completion sequence remains monotonic across concurrent writes and restart', async (context) => {
  const { filePath, journal } = await fixture(context)
  const [first, second] = await Promise.all([
    journal.enqueue(landingInput({ branch: 'ensync/chat-one' })),
    journal.enqueue(landingInput({ branch: 'ensync/chat-two', savedSha: SHA_B })),
  ])
  const restarted = new LandingJournal({ filePath })
  const third = await restarted.enqueue(landingInput({ branch: 'ensync/chat-three', savedSha: SHA_C }))

  assert.deepEqual(
    [first.completionSequence, second.completionSequence, third.completionSequence],
    [1, 2, 3],
  )
})

test('the same saved commit cannot be queued for a different turn', async (context) => {
  const { journal } = await fixture(context)
  await journal.enqueue(landingInput({ turnId: 'turn-one' }))

  await assert.rejects(
    journal.enqueue(landingInput({ turnId: 'turn-two' })),
    /different turn/i,
  )
  assert.deepEqual((await journal.load()).map((item) => item.turnId), ['turn-one'])
})

test('restart removes duplicate saved-commit entries written by an older Host', async (context) => {
  const { filePath, journal } = await fixture(context)
  await journal.enqueue(landingInput({ turnId: 'turn-one' }))
  const envelope = JSON.parse(await readFile(filePath, 'utf8'))
  envelope.payload.items.push({
    ...envelope.payload.items[0],
    id: 'landing-duplicate',
    completionSequence: 2,
    turnId: 'turn-two',
  })
  envelope.payload.nextSequence = 3
  await writeFile(filePath, rechecksum(envelope), 'utf8')

  const restored = await new LandingJournal({ filePath }).load()
  const persisted = JSON.parse(await readFile(filePath, 'utf8'))

  assert.deepEqual(restored.map((item) => item.turnId), ['turn-one'])
  assert.deepEqual(persisted.payload.items.map((item) => item.turnId), ['turn-one'])
  assert.ok(persisted.payload.revision > envelope.payload.revision)
})

test('journal stores only bounded landing metadata, never prompts or provider output', async (context) => {
  const { filePath, journal } = await fixture(context)
  const item = await journal.enqueue(landingInput({
    prompt: 'TOP SECRET PROMPT',
    output: 'RAW PROVIDER OUTPUT',
    anotherField: { token: 'PRIVATE TOKEN' },
  }))
  const stored = await readFile(filePath, 'utf8')

  assert.deepEqual(Object.keys(item).sort(), [
    'attempts',
    'branch',
    'commonGitDirectory',
    'completionSequence',
    'createdAt',
    'deliveryTarget',
    'error',
    'id',
    'projectPath',
    'provider',
    'repositoryPath',
    'savedSha',
    'state',
    'targetBaseSha',
    'targetBranch',
    'turnId',
    'turnIdentityProof',
    'updatedAt',
    'workspacePath',
  ])
  assert.doesNotMatch(stored, /TOP SECRET|RAW PROVIDER|PRIVATE TOKEN/)
})

test('protected-branch delivery is durable terminal metadata and retains the exact turn identity', async (context) => {
  const { filePath, journal } = await fixture(context)
  const held = await journal.enqueue(landingInput({
    deliveryTarget: 'protected_branch',
    turnId: 'turn-current-prompt',
  }))
  const restored = await new LandingJournal({ filePath }).load()

  assert.equal(held.state, 'landed')
  assert.equal(restored[0].state, 'landed')
  assert.equal(restored[0].deliveryTarget, 'protected_branch')
  assert.equal(restored[0].turnId, 'turn-current-prompt')
  assert.equal(restored[0].turnIdentityProof, 'captured')
})

test('legacy turn repair is persisted only against the exact saved item', async (context) => {
  const { filePath, journal } = await fixture(context)
  const queued = await journal.enqueue(landingInput())

  assert.equal(await journal.setTurnIdentity(queued.id, SHA_B, 'turn-wrong', 'legacy_job'), null)
  const repaired = await journal.setTurnIdentity(queued.id, SHA_A, 'turn-recovered', 'legacy_job')
  const restored = await new LandingJournal({ filePath }).load()

  assert.equal(repaired.turnId, 'turn-recovered')
  assert.equal(repaired.turnIdentityProof, 'legacy_job')
  assert.equal(restored[0].turnId, 'turn-recovered')
  assert.equal(restored[0].turnIdentityProof, 'legacy_job')
  await assert.rejects(
    journal.setTurnIdentity(queued.id, SHA_A, 'turn-different', 'legacy_job'),
    /different turn/i,
  )
})

test('compare-and-transition changes only the expected state', async (context) => {
  const { journal } = await fixture(context)
  const queued = await journal.enqueue(landingInput())

  const integrating = await journal.transition(queued.id, 'queued', 'integrating', {
    attempts: 1,
    error: null,
    ignored: 'not persisted',
  })
  const stale = await journal.transition(queued.id, 'queued', 'landed')
  const loaded = await journal.load()

  assert.equal(integrating.state, 'integrating')
  assert.equal(integrating.attempts, 1)
  assert.equal(stale, null)
  assert.equal(loaded[0].state, 'integrating')
  assert.equal('ignored' in loaded[0], false)
})

test('restart recovers interrupted integrating entries to queued exactly once', async (context) => {
  const { filePath, journal } = await fixture(context)
  const queued = await journal.enqueue(landingInput())
  await journal.transition(queued.id, 'queued', 'integrating', { attempts: 1 })

  const recovered = await new LandingJournal({ filePath }).load()
  const stable = await new LandingJournal({ filePath }).load()

  assert.equal(recovered[0].state, 'queued')
  assert.equal(recovered[0].attempts, 1)
  assert.equal(stable[0].state, 'queued')
})

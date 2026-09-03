import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LandingJournal } from './landing-journal.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function landingInput(overrides = {}) {
  return {
    repositoryPath: '/projects/repository',
    projectPath: '/projects/repository/app',
    workspacePath: '/worktrees/chat-one/app',
    branch: 'ensync/chat-one',
    savedSha: SHA_A,
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

test('journal rejects a corrupt checksum instead of trusting partial state', async (context) => {
  const { filePath, journal } = await fixture(context)
  await journal.enqueue(landingInput())
  const encoded = await readFile(filePath, 'utf8')
  await writeFile(filePath, encoded.replace(SHA_A, SHA_B))

  assert.deepEqual(await new LandingJournal({ filePath }).load(), [])
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
  const third = await restarted.enqueue(landingInput({ branch: 'ensync/chat-three' }))

  assert.deepEqual(
    [first.completionSequence, second.completionSequence, third.completionSequence],
    [1, 2, 3],
  )
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
    'completionSequence',
    'createdAt',
    'error',
    'id',
    'projectPath',
    'provider',
    'repositoryPath',
    'savedSha',
    'state',
    'updatedAt',
    'workspacePath',
  ])
  assert.doesNotMatch(stored, /TOP SECRET|RAW PROVIDER|PRIVATE TOKEN/)
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

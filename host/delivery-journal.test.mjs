import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DeliveryJournal } from './delivery-journal.mjs'

const SHA = 'a'.repeat(40)
const item = { id: 'landing-1', repositoryPath: '/repo', projectPath: '/repo/app', targetBranch: 'main', savedSha: SHA, branch: 'ensync/chat-1', provider: 'codex', turnId: 'turn-one', deliveryTarget: 'production', state: 'queued' }

function rechecksum(envelope) {
  envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex')
  return JSON.stringify(envelope)
}

test('delivery journal durably deduplicates a landing SHA', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-delivery-'))
  try {
    const path = join(directory, 'journal.json')
    const journal = new DeliveryJournal({ filePath: path, idFactory: () => 'delivery-1' })
    await journal.upsertLanding(item, 'saved')
    await journal.upsertLanding({ ...item, id: 'landing-2' }, 'landing')
    const restored = await new DeliveryJournal({ filePath: path }).list()
    assert.equal(restored.length, 1)
    assert.equal(restored[0].state, 'landing')
    assert.deepEqual(restored[0].landingIds, ['landing-1', 'landing-2'])
    assert.deepEqual(restored[0].turnIds, ['turn-one'])
    assert.equal(restored[0].turnIdentityProof, 'captured')
    assert.equal(restored[0].productionAncestryVerified, false)
    assert.equal(restored[0].landingState, 'queued')
    assert.equal(restored[0].deliveryTarget, 'production')
    assert.equal((await readFile(path, 'utf8')).includes(SHA), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('one saved commit cannot acquire a second prompt identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-delivery-'))
  try {
    const path = join(directory, 'journal.json')
    const journal = new DeliveryJournal({ filePath: path, idFactory: () => 'delivery-1' })
    await journal.upsertLanding(item, 'saved')

    await assert.rejects(
      journal.upsertLanding({ ...item, id: 'landing-2', turnId: 'turn-two' }, 'landing'),
      /different turn/i,
    )
    assert.deepEqual((await journal.list())[0].turnIds, ['turn-one'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('restart removes ambiguous turn identities written by an older Host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-delivery-'))
  try {
    const path = join(directory, 'journal.json')
    const journal = new DeliveryJournal({ filePath: path, idFactory: () => 'delivery-1' })
    await journal.upsertLanding(item, 'saved')
    const envelope = JSON.parse(await readFile(path, 'utf8'))
    envelope.payload.records[0].turnIds.push('turn-two')
    await writeFile(path, rechecksum(envelope), 'utf8')

    const restored = await new DeliveryJournal({ filePath: path }).list()
    const persisted = JSON.parse(await readFile(path, 'utf8'))

    assert.deepEqual(restored[0].turnIds, ['turn-one'])
    assert.deepEqual(persisted.payload.records[0].turnIds, ['turn-one'])
    assert.ok(persisted.payload.revision > envelope.payload.revision)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('delivery journal recovers the last checksummed backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-delivery-'))
  try {
    const path = join(directory, 'journal.json')
    const journal = new DeliveryJournal({ filePath: path, idFactory: () => 'delivery-1' })
    await journal.upsertLanding(item, 'saved')
    await journal.update('delivery-1', { state: 'landing' })
    await writeFile(path, '{broken', 'utf8')
    const restored = await new DeliveryJournal({ filePath: path }).list()
    assert.equal(restored.length, 1)
    assert.equal(restored[0].savedSha, SHA)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

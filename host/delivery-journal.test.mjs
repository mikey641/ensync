import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DeliveryJournal } from './delivery-journal.mjs'

const SHA = 'a'.repeat(40)
const item = { id: 'landing-1', repositoryPath: '/repo', projectPath: '/repo/app', targetBranch: 'main', savedSha: SHA, branch: 'ensync/chat-1', provider: 'codex', turnId: 'turn-one', deliveryTarget: 'production', state: 'queued' }

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

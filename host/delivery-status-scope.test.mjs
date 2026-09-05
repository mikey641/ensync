import assert from 'node:assert/strict'
import test from 'node:test'
import { activeDeliveryPromptContext, scopeDeliveryStatusForBranch } from '../src/lib/deliveryStatus.mjs'

function record(id, sourceBranch, state, updatedAt, overrides = {}) {
  return {
    id,
    sourceBranches: [sourceBranch],
    state,
    updatedAt,
    productionAt: state === 'production' ? updatedAt : null,
    replacementCommitSha: null,
    ...overrides,
  }
}

test('renderer rejects another chat delivery when an older Host ignores the source-branch filter', () => {
  const chatOneProduction = record('one-production', 'ensync/chat-one', 'production', '2026-09-05T01:00:00.000Z')
  const chatTwoLanding = record('two-landing', 'ensync/chat-two', 'landing', '2026-09-05T02:00:00.000Z')
  const scoped = scopeDeliveryStatusForBranch({
    current: chatOneProduction,
    production: chatOneProduction,
    pending: chatTwoLanding,
    records: [chatTwoLanding, chatOneProduction],
  }, 'ensync/chat-two')

  assert.equal(scoped.current?.id, 'two-landing')
  assert.equal(scoped.production, null)
  assert.equal(scoped.pending?.id, 'two-landing')
  assert.deepEqual(scoped.records.map(({ id }) => id), ['two-landing'])
})

test('renderer keeps verified production and newer pending work for only the requested chat', () => {
  const production = record('production', 'ensync/chat-one', 'production', '2026-09-05T01:00:00.000Z')
  const pending = record('pending', 'ensync/chat-one', 'building', '2026-09-05T02:00:00.000Z')
  const other = record('other', 'ensync/chat-two', 'landing', '2026-09-05T03:00:00.000Z')
  const scoped = scopeDeliveryStatusForBranch({ current: other, production, pending: other, records: [other, pending, production] }, 'ensync/chat-one')

  assert.equal(scoped.current?.id, 'pending')
  assert.equal(scoped.production?.id, 'production')
  assert.equal(scoped.pending?.id, 'pending')
  assert.deepEqual(scoped.records.map(({ id }) => id), ['pending', 'production'])
})

test('renderer keeps a newer merge ahead of an older delivery whose polling timestamp changed later', () => {
  const olderUnavailable = record('older-unavailable', 'ensync/chat-one', 'unavailable', '2026-09-05T04:00:00.000Z', {
    createdAt: '2026-09-05T02:00:00.000Z',
  })
  const newerMerge = record('newer-merge', 'ensync/chat-one', 'landing', '2026-09-05T03:00:00.000Z', {
    createdAt: '2026-09-05T03:00:00.000Z',
    landingState: 'integrating',
  })
  const scoped = scopeDeliveryStatusForBranch({ records: [olderUnavailable, newerMerge] }, 'ensync/chat-one')

  assert.equal(scoped.current?.id, 'newer-merge')
  assert.equal(scoped.pending?.id, 'newer-merge')
  assert.deepEqual(scoped.records.map(({ id }) => id), ['newer-merge', 'older-unavailable'])
})

test('renderer fails closed when no returned record proves exact chat ownership', () => {
  const other = record('other', 'ensync/chat-two', 'production', '2026-09-05T03:00:00.000Z')
  assert.deepEqual(scopeDeliveryStatusForBranch({ current: other, production: other, pending: null, records: [other] }, 'ensync/chat-one'), {
    current: null,
    production: null,
    pending: null,
    records: [],
  })
})

test('an active prompt leads the card even when another window owns the run', () => {
  const delivered = record('production', 'ensync/chat-one', 'production', '2026-09-05T03:00:00.000Z', {
    turnIds: [],
  })
  const messages = [{ role: 'user', turnId: 'active-turn', content: 'fix the current issue' }]

  assert.deepEqual(activeDeliveryPromptContext(delivered, delivered, messages, 'active-turn'), {
    hasUnsavedActivePrompt: true,
    activePrompt: messages[0],
  })
})

test('a prompt already linked to the delivery is not presented as unsaved work', () => {
  const delivered = record('production', 'ensync/chat-one', 'production', '2026-09-05T03:00:00.000Z', {
    turnIds: ['delivered-turn'],
  })

  assert.deepEqual(activeDeliveryPromptContext(delivered, delivered, [], 'delivered-turn'), {
    hasUnsavedActivePrompt: false,
    activePrompt: null,
  })
})

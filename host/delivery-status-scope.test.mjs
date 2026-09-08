import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deliveryPromptContext,
  productionNotificationsNeedingAlert,
  scopeDeliveryStatusForBranch,
  verifiedProductionDeliveryEntries,
  verifiedProductionDeliveryKeys,
} from '../src/lib/deliveryStatus.mjs'

function record(id, sourceBranch, state, updatedAt, overrides = {}) {
  return {
    id,
    sourceBranches: [sourceBranch],
    state,
    updatedAt,
    productionAt: state === 'production' ? updatedAt : null,
    replacementCommitSha: null,
    turnIdentityProof: null,
    productionAncestryVerified: false,
    ...overrides,
  }
}

test('Production-ready notification keys require exact ancestry verification', () => {
  const ready = record('ready', 'ensync/chat-one', 'production', '2026-09-05T18:00:00.000Z', {
    productionCommitSha: 'a'.repeat(40),
    replacementCommitSha: 'b'.repeat(40),
    productionAncestryVerified: true,
    deliveryTarget: 'production',
  })
  const unverified = { ...ready, id: 'unverified', productionAncestryVerified: false }
  const held = { ...ready, id: 'held', deliveryTarget: 'protected_branch' }

  assert.deepEqual(verifiedProductionDeliveryKeys({ records: [ready, unverified, held] }), [
    `ready:${'b'.repeat(40)}:2026-09-05T18:00:00.000Z`,
  ])
  assert.deepEqual(verifiedProductionDeliveryEntries({ records: [ready, unverified, held] }), [{
    key: `ready:${'b'.repeat(40)}:2026-09-05T18:00:00.000Z`,
    productionAt: '2026-09-05T18:00:00.000Z',
  }])
})

test('a recent Production transition missed during relaunch alerts once, while old hydration stays silent', () => {
  const nowMs = Date.parse('2026-09-05T18:02:00.000Z')
  const recent = [{ key: 'recent', productionAt: '2026-09-05T18:01:30.000Z' }]
  const old = [{ key: 'old', productionAt: '2026-09-05T17:00:00.000Z' }]

  const recentFirstLoad = productionNotificationsNeedingAlert(recent, new Set(), { nowMs })
  assert.equal(recentFirstLoad.alert, true)
  assert.deepEqual(recentFirstLoad.alertKeys, ['recent'])
  assert.deepEqual([...recentFirstLoad.announced], [])
  assert.equal(productionNotificationsNeedingAlert(recent, recentFirstLoad.announced, { nowMs }).alert, true)
  recentFirstLoad.announced.add('recent')
  assert.equal(productionNotificationsNeedingAlert(recent, recentFirstLoad.announced, { nowMs }).alert, false)

  const oldFirstLoad = productionNotificationsNeedingAlert(old, new Set(), { nowMs })
  assert.equal(oldFirstLoad.alert, false)
  assert.deepEqual(oldFirstLoad.alertKeys, [])
  assert.deepEqual([...oldFirstLoad.announced], ['old'])
})

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

test('a repaired replacement remains the current prompt delivery until Production is verified', () => {
  const production = record('older-production', 'ensync/chat-one', 'production', '2026-09-05T01:00:00.000Z', {
    createdAt: '2026-09-05T01:00:00.000Z',
    replacementCommitSha: 'd'.repeat(40),
    turnIds: ['older-turn'],
    turnIdentityProof: 'captured',
    productionAncestryVerified: true,
  })
  const repairing = record('latest-repair', 'ensync/chat-one', 'repairing', '2026-09-05T02:00:00.000Z', {
    createdAt: '2026-09-05T02:00:00.000Z',
    replacementCommitSha: 'e'.repeat(40),
    turnIds: ['latest-turn'],
    turnIdentityProof: 'captured',
  })
  const scoped = scopeDeliveryStatusForBranch({ records: [production, repairing] }, 'ensync/chat-one')
  const messages = [{ role: 'user', turnId: 'latest-turn', content: 'repair this', deliveryStatus: 'completed' }]

  assert.equal(scoped.current?.id, 'latest-repair')
  assert.equal(scoped.pending?.id, 'latest-repair')
  assert.equal(scoped.production?.id, 'older-production')
  assert.equal(deliveryPromptContext(scoped.current, scoped.production, messages, null).deliveryTracksPrompt, true)
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

  assert.deepEqual(deliveryPromptContext(delivered, delivered, messages, 'active-turn'), {
    prompt: messages[0],
    promptIsActive: true,
    hasUnsavedActivePrompt: true,
    deliveryTracksPrompt: false,
    deliveryLinkProof: null,
  })
})

test('a prompt already linked to the delivery is not presented as unsaved work', () => {
  const delivered = record('production', 'ensync/chat-one', 'production', '2026-09-05T03:00:00.000Z', {
    turnIds: ['delivered-turn'],
    turnIdentityProof: 'captured',
    productionAncestryVerified: true,
  })
  const messages = [{ role: 'user', turnId: 'delivered-turn', content: 'ship it', deliveryStatus: 'completed' }]

  assert.deepEqual(deliveryPromptContext(delivered, delivered, messages, 'delivered-turn'), {
    prompt: messages[0],
    promptIsActive: true,
    hasUnsavedActivePrompt: false,
    deliveryTracksPrompt: true,
    deliveryLinkProof: 'host',
  })
})

test('the latest completed prompt remains visible and legacy delivery is earlier work', () => {
  const delivered = record('production', 'ensync/chat-one', 'production', '2026-09-05T03:00:00.000Z', {
    turnIds: [],
  })
  const messages = [{ role: 'user', turnId: 'latest-turn', content: 'compare these files', deliveryStatus: 'completed' }]

  assert.deepEqual(deliveryPromptContext(delivered, delivered, messages, null), {
    prompt: messages[0],
    promptIsActive: false,
    hasUnsavedActivePrompt: false,
    deliveryTracksPrompt: false,
    deliveryLinkProof: null,
  })
})

test('a completed prompt is linked only by its exact turn id', () => {
  const delivered = record('production', 'ensync/chat-one', 'production', '2026-09-05T03:00:00.000Z', {
    turnIds: ['latest-turn'],
    turnIdentityProof: 'commit_trailer',
    productionAncestryVerified: true,
  })
  const messages = [{ role: 'user', turnId: 'latest-turn', content: 'ship this fix', deliveryStatus: 'completed' }]

  assert.deepEqual(deliveryPromptContext(delivered, delivered, messages, null), {
    prompt: messages[0],
    promptIsActive: false,
    hasUnsavedActivePrompt: false,
    deliveryTracksPrompt: true,
    deliveryLinkProof: 'host',
  })
})

test('renderer evidence never guesses a missing Host turn identity', () => {
  const delivered = record('production', 'ensync/chat-one', 'production', '2026-09-05T03:00:00.000Z', {
    savedSha: '3215687820e0750b81c3dd33c40fe62300771f51',
    turnIds: [],
  })
  const messages = [
    { role: 'user', turnId: 'turn-current', content: 'fix the pdf', deliveryStatus: 'completed' },
    { role: 'agent', turnId: 'turn-current', content: 'fixed' },
  ]
  const events = [{
    type: 'notice',
    code: 'automatic_landing_queued',
    message: 'Queued ensync/chat-one at 3215687820e0 for immediate automatic landing.',
  }]

  assert.deepEqual(deliveryPromptContext(delivered, delivered, messages, null, events), {
    prompt: messages[0],
    promptIsActive: false,
    hasUnsavedActivePrompt: false,
    deliveryTracksPrompt: false,
    deliveryLinkProof: null,
  })
})

test('a turn id without Host proof or production ancestry is not linked by the renderer', () => {
  const delivered = record('production', 'ensync/chat-one', 'production', '2026-09-05T03:00:00.000Z', {
    turnIds: ['turn-current'],
  })
  const messages = [{ role: 'user', turnId: 'turn-current', content: 'ship this', deliveryStatus: 'completed' }]

  assert.equal(deliveryPromptContext(delivered, delivered, messages, null).deliveryTracksPrompt, false)
  delivered.turnIdentityProof = 'legacy_job'
  assert.equal(deliveryPromptContext(delivered, delivered, messages, null).deliveryTracksPrompt, false)
  delivered.productionAncestryVerified = true
  assert.equal(deliveryPromptContext(delivered, delivered, messages, null).deliveryTracksPrompt, true)
})

test('legacy evidence cannot link a different saved commit or unfinished turn', () => {
  const delivered = record('production', 'ensync/chat-one', 'production', '2026-09-05T03:00:00.000Z', {
    savedSha: 'f'.repeat(40),
    turnIds: [],
  })
  const messages = [
    { role: 'user', turnId: 'turn-current', content: 'fix the pdf', deliveryStatus: 'pending' },
    { role: 'agent', turnId: 'turn-current', content: 'partial' },
  ]
  const events = [{
    type: 'notice',
    code: 'automatic_landing_queued',
    message: 'Queued ensync/chat-one at 3215687820e0 for immediate automatic landing.',
  }]

  const context = deliveryPromptContext(delivered, delivered, messages, null, events)
  assert.equal(context.deliveryTracksPrompt, false)
  assert.equal(context.deliveryLinkProof, null)
})

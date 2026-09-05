import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DeliveryCoordinator,
  deliveryTurnIdFromCommitMessage,
  deliveryTurnIdentityFromCommitMessage,
} from './delivery-coordinator.mjs'

const SHA = 'a'.repeat(40)
const item = { id: 'landing-1', repositoryPath: '/repo', projectPath: '/repo/app', targetBranch: 'main', savedSha: 'b'.repeat(40), branch: 'ensync/chat-1', provider: 'codex' }

class MemoryJournal {
  records = []
  async list() { return structuredClone(this.records) }
  async upsertLanding(input, state) {
    let record = this.records.find((candidate) => candidate.savedSha === input.savedSha)
    if (!record) {
      const now = new Date().toISOString()
      record = { ...input, id: `delivery-${this.records.length + 1}`, state, productionCommitSha: null, replacementCommitSha: null, sourceBranches: [input.branch], sourceProviders: [input.provider], turnIds: [input.turnId].filter(Boolean), turnIdentityProof: input.turnIdentityProof ?? (input.turnId ? 'captured' : null), productionAncestryVerified: false, landingState: input.state ?? null, deliveryTarget: input.deliveryTarget ?? 'production', attemptedProviders: [], repairAttempts: 0, repairState: 'idle', createdAt: now, updatedAt: now }
      this.records.push(record)
    } else Object.assign(record, {
      state,
      landingState: input.state ?? record.landingState,
      deliveryTarget: input.deliveryTarget ?? record.deliveryTarget,
      turnIds: [...new Set([...record.turnIds, input.turnId].filter(Boolean))],
      turnIdentityProof: record.turnIdentityProof ?? input.turnIdentityProof ?? (input.turnId ? 'captured' : null),
    })
    return structuredClone(record)
  }
  async update(id, patch) {
    const record = this.records.find((candidate) => candidate.id === id)
    Object.assign(record, patch, { updatedAt: new Date().toISOString() })
    return structuredClone(record)
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('commit metadata recovers explicit and legacy Host-authored turn identities', () => {
  assert.equal(deliveryTurnIdFromCommitMessage([
    'Ensync agent work (succeeded)',
    '',
    'Provider: codex',
    'Job: job-turn-1788609131718-x3osi7-codex-1',
    'Turn-ID: turn-explicit',
  ].join('\n')), 'turn-explicit')
  assert.equal(deliveryTurnIdFromCommitMessage([
    'Ensync agent work (succeeded)',
    '',
    'Provider: codex',
    'Job: job-turn-1788609131718-x3osi7-codex-1',
  ].join('\n')), 'turn-1788609131718-x3osi7')
  assert.equal(deliveryTurnIdFromCommitMessage('Provider: codex\nJob: unrelated-job'), null)
  assert.deepEqual(deliveryTurnIdentityFromCommitMessage([
    'Provider: codex',
    'Job: job-turn-1788609131718-x3osi7-codex-1',
    'Workspace-Branch: ensync/chat-one',
  ].join('\n'), { provider: 'codex', branch: 'ensync/chat-one' }), {
    turnId: 'turn-1788609131718-x3osi7',
    proof: 'legacy_job',
  })
  assert.equal(deliveryTurnIdentityFromCommitMessage([
    'Provider: codex',
    'Job: job-turn-1788609131718-x3osi7-codex-1',
    'Workspace-Branch: ensync/chat-other',
  ].join('\n'), { provider: 'codex', branch: 'ensync/chat-one' }), null)
})

test('status durably repairs a legacy delivery record from immutable commit identity', async () => {
  const journal = new MemoryJournal()
  const legacy = await journal.upsertLanding({ ...item, turnId: null }, 'saved')
  await journal.update(legacy.id, { state: 'production', productionCommitSha: SHA })
  let recoveries = 0
  const coordinator = new DeliveryCoordinator({
    journal,
    resolveTurnId: async (record) => {
      recoveries += 1
      assert.equal(record.savedSha, item.savedSha)
      return { turnId: 'turn-recovered', proof: 'legacy_job' }
    },
    isAncestor: async (repositoryPath, savedSha, productionSha) => {
      assert.equal(repositoryPath, '/repo')
      assert.equal(savedSha, item.savedSha)
      assert.equal(productionSha, SHA)
      return true
    },
  })

  const status = await coordinator.status('/repo/app', 'ensync/chat-1')
  assert.deepEqual(status.current.turnIds, ['turn-recovered'])
  assert.equal(status.current.turnIdentityProof, 'legacy_job')
  assert.equal(status.current.productionAncestryVerified, true)
  assert.deepEqual(journal.records[0].turnIds, ['turn-recovered'])
  await coordinator.status('/repo/app', 'ensync/chat-1')
  assert.equal(recoveries, 1)
})

test('status refuses to certify prompt production when Git ancestry is absent', async () => {
  const journal = new MemoryJournal()
  const tracked = await journal.upsertLanding({ ...item, turnId: 'turn-current' }, 'saved')
  await journal.update(tracked.id, { state: 'production', productionCommitSha: SHA })
  const coordinator = new DeliveryCoordinator({ journal, isAncestor: async () => false })

  const status = await coordinator.status('/repo/app', 'ensync/chat-1')

  assert.equal(status.current.turnIdentityProof, 'captured')
  assert.equal(status.current.productionAncestryVerified, false)
})

test('delivery follows an exact pushed SHA through build to production', async () => {
  const journal = new MemoryJournal()
  let inspection = 0
  const coordinator = new DeliveryCoordinator({
    journal,
    pollMs: 5,
    adapters: [{ inspect: async () => (++inspection === 1
      ? { available: true, provider: 'vercel', state: 'building', deploymentId: 'd1' }
      : { available: true, provider: 'vercel', state: 'ready', deploymentId: 'd1' }) }],
  })
  coordinator.handleLandingEvent({ type: 'queued', item })
  await settle()
  coordinator.handleLandingEvent({ type: 'pushed', items: [item], repositoryPath: '/repo', productionCommitSha: SHA, targetBranch: 'main' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const status = await coordinator.status('/repo/app')
  assert.equal(status.current.productionCommitSha, SHA)
  assert.equal(status.current.state, 'production')
  await coordinator.shutdown()
})

test('a successful authenticated retry clears an earlier lookup failure', async () => {
  const journal = new MemoryJournal()
  const coordinator = new DeliveryCoordinator({
    journal,
    pollMs: 5,
    adapters: [{ inspect: async () => ({
      available: true,
      provider: 'vercel',
      state: 'ready',
      deploymentId: 'exact-deployment',
    }) }],
  })
  coordinator.handleLandingEvent({ type: 'queued', item })
  await settle()
  await journal.update(journal.records[0].id, {
    state: 'unavailable',
    failureCode: 'forbidden',
    failureMessage: 'Vercel deployment lookup returned HTTP 403.',
    failureLog: 'stale lookup failure',
  })
  coordinator.handleLandingEvent({ type: 'pushed', items: [item], repositoryPath: '/repo', productionCommitSha: SHA, targetBranch: 'main' })
  await settle()
  const status = await coordinator.status('/repo/app')
  assert.equal(status.current.state, 'production')
  assert.equal(status.current.failureCode, null)
  assert.equal(status.current.failureMessage, null)
  assert.equal(status.current.failureLogAvailable, false)
  await coordinator.shutdown()
})

test('landing status exposes exact merge activity, prompt identity, and merge description', async () => {
  const journal = new MemoryJournal()
  const coordinator = new DeliveryCoordinator({
    journal,
    describeCommit: async () => 'Update signing completion recovery',
  })
  const tracked = { ...item, state: 'integrating', turnId: 'turn-signed-contract' }
  coordinator.handleLandingEvent({ type: 'integrating', item: tracked })
  await settle()

  const status = await coordinator.status('/repo/app', 'ensync/chat-1')
  assert.equal(status.pending.landingState, 'integrating')
  assert.deepEqual(status.pending.turnIds, ['turn-signed-contract'])
  assert.equal(status.pending.description, 'Update signing completion recovery')
})

test('protected-branch-only delivery is saved without deployment polling', async () => {
  const journal = new MemoryJournal()
  let inspections = 0
  const coordinator = new DeliveryCoordinator({
    journal,
    pollMs: 1,
    adapters: [{ inspect: async () => { inspections += 1; return { available: true, provider: 'vercel', state: 'ready' } } }],
  })
  coordinator.handleLandingEvent({
    type: 'held',
    item: { ...item, state: 'held', deliveryTarget: 'protected_branch', turnId: 'turn-held' },
  })
  await settle()
  const status = await coordinator.status('/repo/app')

  assert.equal(status.pending.state, 'saved')
  assert.equal(status.pending.deliveryTarget, 'protected_branch')
  assert.equal(status.pending.landingState, 'held')
  assert.equal(inspections, 0)
})

test('a running user chat owns repair and prevents a duplicate provider run', async () => {
  const journal = new MemoryJournal()
  let repairStarts = 0
  const coordinator = new DeliveryCoordinator({
    journal,
    pollMs: 50,
    adapters: [{ inspect: async () => ({ available: true, provider: 'vercel', state: 'failed', failureMessage: 'build failed' }) }],
    findActiveChat: () => ({ id: 'job-manual', provider: 'claude' }),
    startRepair: async () => { repairStarts++; throw new Error('should not run') },
  })
  coordinator.handleLandingEvent({ type: 'queued', item })
  await settle()
  coordinator.handleLandingEvent({ type: 'pushed', items: [item], repositoryPath: '/repo', productionCommitSha: SHA, targetBranch: 'main' })
  await settle()
  const status = await coordinator.status('/repo/app')
  assert.equal(status.current.repairState, 'manual')
  assert.equal(status.current.repairJobId, 'job-manual')
  assert.equal(repairStarts, 0)
  await coordinator.shutdown()
})

test('deployment failure starts one automatic max-effort repair owner', async () => {
  const journal = new MemoryJournal()
  const repairs = []
  const coordinator = new DeliveryCoordinator({
    journal,
    pollMs: 100,
    adapters: [{ inspect: async () => ({ available: true, provider: 'vercel', state: 'failed', failureMessage: 'build failed' }) }],
    startRepair: async (record) => {
      repairs.push(record)
      return { jobId: 'deliveryrepair-1', provider: 'codex', completion: new Promise(() => {}) }
    },
  })
  coordinator.handleLandingEvent({ type: 'queued', item })
  await settle()
  coordinator.handleLandingEvent({ type: 'pushed', items: [item], repositoryPath: '/repo', productionCommitSha: SHA, targetBranch: 'main' })
  await settle()
  const status = await coordinator.status('/repo/app')
  assert.equal(repairs.length, 1)
  assert.equal(status.current.repairState, 'running')
  assert.equal(status.current.repairProvider, 'codex')
  await coordinator.shutdown()
})

test('startup recovers an already-pushed production head and reports pending work separately', async () => {
  const journal = new MemoryJournal()
  await journal.upsertLanding(item, 'landing')
  const coordinator = new DeliveryCoordinator({
    journal,
    pollMs: 5,
    resolvePushedHead: async () => SHA,
    adapters: [{ inspect: async (record) => ({
      available: true,
      provider: 'vercel',
      state: record.productionCommitSha === SHA ? 'ready' : 'missing',
      deploymentId: 'production-deployment',
    }) }],
  })
  await coordinator.start()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const status = await coordinator.status('/repo/app')
  assert.equal(status.production.productionCommitSha, SHA)
  assert.equal(status.production.state, 'production')
  assert.equal(status.pending.savedSha, item.savedSha)
  assert.equal(status.pending.state, 'landing')
  assert.equal(status.current.id, status.pending.id)
  await coordinator.shutdown()
})

test('newer landing work remains current when polling touches an older unavailable delivery', async () => {
  const journal = new MemoryJournal()
  await journal.upsertLanding({ ...item, id: 'landing-old', savedSha: 'c'.repeat(40) }, 'unavailable')
  await journal.upsertLanding({ ...item, id: 'landing-new', savedSha: 'd'.repeat(40), state: 'integrating' }, 'landing')
  Object.assign(journal.records[0], {
    createdAt: '2026-09-05T02:00:00.000Z',
    updatedAt: '2026-09-05T04:00:00.000Z',
  })
  Object.assign(journal.records[1], {
    createdAt: '2026-09-05T03:00:00.000Z',
    updatedAt: '2026-09-05T03:00:00.000Z',
  })
  const coordinator = new DeliveryCoordinator({ journal })

  const status = await coordinator.status('/repo/app')

  assert.equal(status.current.savedSha, 'd'.repeat(40))
  assert.equal(status.pending.savedSha, 'd'.repeat(40))
})

test('delivery status isolates records to the requesting conversation branch', async () => {
  const journal = new MemoryJournal()
  const other = { ...item, id: 'landing-2', savedSha: 'c'.repeat(40), branch: 'ensync/chat-2' }
  const firstRecord = await journal.upsertLanding(item, 'production')
  await journal.update(firstRecord.id, { productionCommitSha: SHA, productionAt: new Date().toISOString() })
  await journal.upsertLanding(other, 'landing')
  const coordinator = new DeliveryCoordinator({ journal })

  const firstStatus = await coordinator.status('/repo/app', 'ensync/chat-1')
  const secondStatus = await coordinator.status('/repo/app', 'ensync/chat-2')

  assert.equal(firstStatus.production.savedSha, item.savedSha)
  assert.equal(firstStatus.pending, null)
  assert.equal(secondStatus.production, null)
  assert.equal(secondStatus.pending.savedSha, other.savedSha)
})

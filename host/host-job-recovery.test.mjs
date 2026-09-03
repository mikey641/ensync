import assert from 'node:assert/strict'
import test from 'node:test'

import * as hostJobRecovery from '../src/lib/hostJobRecovery.mjs'

const {
  adoptReconnectableHostJobState,
  retryableOccupiedJobProbes,
  runningHostJobCandidates,
} = hostJobRecovery

const predecessorTranscriptFingerprint = 'a'.repeat(64)

test('renderer state loss probes only deterministic recent Host job identities', () => {
  const chats = [{
    id: 'chat-a',
    provider: 'codex',
    messages: [
      { role: 'user', turnId: 'legacy', deliveryStatus: 'failed' },
      { role: 'user', turnId: 'turn-12345678', deliveryStatus: 'failed' },
    ],
  }]

  assert.deepEqual(runningHostJobCandidates(chats), [
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'codex', attempt: 1, jobId: 'job-turn-12345678-codex-1' },
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'codex', attempt: 2, jobId: 'job-turn-12345678-codex-2' },
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'claude', attempt: 1, jobId: 'job-turn-12345678-claude-1' },
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'claude', attempt: 2, jobId: 'job-turn-12345678-claude-2' },
  ])
})

test('generic Host-job rediscovery excludes chats with an occupied owner', () => {
  const chats = [{
    id: 'chat-occupied',
    provider: 'claude',
    messages: [{ role: 'user', turnId: 'turn-12345678', deliveryStatus: 'pending' }],
  }, {
    id: 'chat-detached',
    provider: 'codex',
    messages: [{ role: 'user', turnId: 'turn-87654321', deliveryStatus: 'interrupted' }],
  }]

  assert.deepEqual(
    runningHostJobCandidates(chats, {
      maximumAttempts: 1,
      excludedChatIds: ['chat-occupied'],
    }).map((candidate) => candidate.chatId),
    ['chat-detached', 'chat-detached'],
  )
})

test('a fast owner rerender cannot restart or cancel its slower scheduled sibling', async () => {
  assert.equal(typeof hostJobRecovery.createOccupiedJobProbeCoordinator, 'function')
  const coordinator = hostJobRecovery.createOccupiedJobProbeCoordinator()
  const fast = coordinator.reserve('chat-a\0job-a')
  const slow = coordinator.reserve('chat-b\0job-b')
  assert.ok(fast?.start())

  // The fast result changes occupied state and reruns the React effect. The
  // unchanged slow owner remains reserved, including while its timer has not
  // fired yet, so the rerun cannot restart its backoff forever.
  assert.ok(fast.finish())
  assert.equal(slow.isCurrent(), true)
  assert.equal(coordinator.reserve('chat-b\0job-b'), null)

  // Its original timer can then start and its response completes independently.
  assert.ok(slow.start())
  assert.ok(slow.finish())
  assert.ok(coordinator.reserve('chat-b\0job-b'))
})

test('cancelled timers and transient failures never suppress an unproven exact job', () => {
  const occupied = {
    'chat-a': {
      ownerJobId: 'job-turn-12345678-codex-1', turnId: 'turn-12345678', targetKind: 'local',
    },
    'chat-b': {
      ownerJobId: 'job-turn-87654321-claude-1', turnId: 'turn-87654321', targetKind: 'local',
    },
  }

  const firstSchedule = retryableOccupiedJobProbes(occupied, [])
  assert.deepEqual(firstSchedule.map((candidate) => candidate.chatId), ['chat-a', 'chat-b'])

  // An occupied-state update can cancel both timers after only A responded.
  // With no 404 proof recorded for B, the next pass must schedule B again.
  const afterCancellation = retryableOccupiedJobProbes(occupied, [])
  assert.deepEqual(afterCancellation.map((candidate) => candidate.chatId), ['chat-a', 'chat-b'])

  const onlyMissingA = [`chat-a\0${occupied['chat-a'].ownerJobId}`]
  assert.deepEqual(
    retryableOccupiedJobProbes(occupied, onlyMissingA).map((candidate) => candidate.chatId),
    ['chat-b'],
  )
})

test('only an exact 404 Host status permanently suppresses an occupied-job probe', () => {
  assert.equal(typeof hostJobRecovery.shouldSuppressOccupiedJobProbe, 'function')
  assert.equal(hostJobRecovery.shouldSuppressOccupiedJobProbe(404), true)
  assert.equal(hostJobRecovery.shouldSuppressOccupiedJobProbe(409), false)
  assert.equal(hostJobRecovery.shouldSuppressOccupiedJobProbe(500), false)
  assert.equal(hostJobRecovery.shouldSuppressOccupiedJobProbe(undefined), false)
})

test('predecessor transcript fingerprints bind the exact ordered history through the active user turn', async () => {
  assert.equal(typeof hostJobRecovery.predecessorTranscriptFingerprint, 'function')
  const messages = [
    { id: 'u-1', role: 'user', content: 'first', attachments: [], turnId: 'turn-first111', deliveryStatus: 'completed', time: '10:00' },
    { id: 'a-1', role: 'agent', content: 'reply', provider: 'claude', turnId: 'turn-first111', time: '10:01' },
    { id: 'u-2', role: 'user', content: 'active', attachments: [{ name: 'note.txt', path: 'C:\\tmp\\note.txt' }], turnId: 'turn-12345678', deliveryStatus: 'pending', time: '10:02' },
    { id: 'u-3', role: 'user', content: 'queued later', attachments: [], turnId: 'turn-later999', deliveryStatus: 'queued', time: '10:03' },
  ]
  const matching = await hostJobRecovery.predecessorTranscriptFingerprint(messages, 'turn-12345678')
  assert.match(matching, /^[0-9a-f]{64}$/)
  assert.equal(await hostJobRecovery.predecessorTranscriptFingerprint(
    messages.map((message) => ({
      ...message,
      time: 'different',
      deliveryStatus: message.id === 'u-2' ? 'interrupted' : message.deliveryStatus,
    })),
    'turn-12345678',
  ), matching)
  assert.notEqual(await hostJobRecovery.predecessorTranscriptFingerprint(
    messages.map((message) => message.id === 'u-1' ? { ...message, deliveryStatus: 'failed' } : message),
    'turn-12345678',
  ), matching)
  assert.notEqual(await hostJobRecovery.predecessorTranscriptFingerprint(
    messages.map((message) => message.id === 'u-1' ? { ...message, content: 'changed' } : message),
    'turn-12345678',
  ), matching)
  assert.notEqual(await hostJobRecovery.predecessorTranscriptFingerprint(
    messages.map((message) => message.id === 'a-1' ? { ...message, content: 'changed reply' } : message),
    'turn-12345678',
  ), matching)
  assert.notEqual(await hostJobRecovery.predecessorTranscriptFingerprint(messages.filter((message) => message.id !== 'u-1'), 'turn-12345678'), matching)
  assert.notEqual(await hostJobRecovery.predecessorTranscriptFingerprint(messages.filter((message) => message.id !== 'a-1'), 'turn-12345678'), matching)
  assert.notEqual(await hostJobRecovery.predecessorTranscriptFingerprint([
    { id: 'u-0', role: 'user', content: 'extra predecessor', attachments: [], turnId: 'turn-extra000' },
    ...messages,
  ], 'turn-12345678'), matching)
  assert.notEqual(await hostJobRecovery.predecessorTranscriptFingerprint([
    ...messages.slice(0, 2),
    { id: 'a-extra', role: 'agent', content: 'extra predecessor reply', provider: 'codex', turnId: 'turn-extra000' },
    ...messages.slice(2),
  ], 'turn-12345678'), matching)
  assert.equal(await hostJobRecovery.predecessorTranscriptFingerprint(messages.filter((message) => message.id !== 'u-2'), 'turn-12345678'), null)
  assert.equal(await hostJobRecovery.predecessorTranscriptFingerprint([
    ...messages.slice(0, 3),
    { id: 'a-2', role: 'agent', content: 'already answered', turnId: 'turn-12345678' },
  ], 'turn-12345678'), null)
})

test('Stop during delayed transcript hashing prevents run persistence and Host admission', async () => {
  assert.equal(typeof hostJobRecovery.beginRunAfterPredecessorFingerprint, 'function')
  const controller = new AbortController()
  let rejectFingerprint
  const delayedFingerprint = new Promise((_resolve, reject) => { rejectFingerprint = reject })
  let persisted = 0
  let admitted = 0
  const run = hostJobRecovery.beginRunAfterPredecessorFingerprint(
    delayedFingerprint,
    controller.signal,
    () => {
      persisted += 1
      admitted += 1
    },
  )

  controller.abort()
  await assert.rejects(run, (error) => error?.name === 'AbortError')
  assert.equal(persisted, 0)
  assert.equal(admitted, 0)

  // The abandoned digest is still observed, so a delayed failure cannot
  // become an unhandled rejection after cancellation wins the race.
  rejectFingerprint(new Error('late Web Crypto failure'))
  await new Promise((resolve) => setImmediate(resolve))
})

test('unavailable transcript hashing still permits an ordinary non-adoptable admission', async () => {
  assert.equal(typeof hostJobRecovery.beginRunAfterPredecessorFingerprint, 'function')
  const received = await hostJobRecovery.beginRunAfterPredecessorFingerprint(
    Promise.resolve(null),
    new AbortController().signal,
    (fingerprint) => fingerprint,
  )
  assert.equal(received, null)
})

test('an exact running Host job replaces only the stale renderer terminal state', () => {
  const state = {
    chats: [{
      id: 'chat-a', projectId: 'project-a', provider: 'codex', sizeTier: 'large', subtitle: 'Run failed',
      messages: [
        { role: 'user', turnId: 'turn-12345678', deliveryStatus: 'failed' },
        { role: 'user', turnId: 'turn-later999', deliveryStatus: 'failed' },
      ],
      continuation: { turnId: 'turn-12345678', status: 'reconciliation_required' },
    }],
    chatErrors: { 'chat-a': 'The detached Ensync Host ended.' },
    chatExecutionEvents: { 'chat-a': [{ type: 'error', code: 'host_job_orphaned' }] },
    inFlightRuns: {},
  }
  const candidate = runningHostJobCandidates(state.chats, { maximumAttempts: 1 })[0]
  const recovered = adoptReconnectableHostJobState(state, {
    candidate,
    job: {
      id: candidate.jobId, kind: 'local', state: 'running', startedAt: '2026-08-07T17:35:49.272Z',
      finishedAt: null, firstSequence: 1, lastSequence: 612, providerProcessStarted: true,
    },
    projectPath: '/project-a',
    executionTarget: 'local',
  })

  assert.equal(recovered.chats[0].subtitle, 'Working now')
  assert.equal(recovered.chats[0].messages[0].deliveryStatus, 'pending')
  assert.equal(recovered.chats[0].messages[1].deliveryStatus, 'failed')
  assert.equal(recovered.chats[0].continuation, undefined)
  assert.equal(recovered.chatErrors['chat-a'], null)
  assert.deepEqual(recovered.chatExecutionEvents['chat-a'], [])
  assert.equal(recovered.inFlightRun.jobId, candidate.jobId)
  assert.equal(recovered.inFlightRun.lastEventSequence, 0)
})

test('a buffered completed Host job can finish an exact stale renderer turn', () => {
  const state = {
    chats: [{
      id: 'chat-a', projectId: 'project-a', provider: 'codex',
      messages: [{ role: 'user', turnId: 'turn-12345678', deliveryStatus: 'failed' }],
    }],
  }
  const candidate = runningHostJobCandidates(state.chats, { maximumAttempts: 1 })[0]
  const recovered = adoptReconnectableHostJobState(state, {
    candidate,
    job: { id: candidate.jobId, state: 'completed' },
    projectPath: '/project-a',
    executionTarget: 'local',
  })
  assert.equal(recovered.inFlightRun.jobId, candidate.jobId)
  assert.equal(recovered.chats[0].messages[0].deliveryStatus, 'pending')
})

test('a failed or mismatched Host job cannot revive a renderer run', () => {
  const state = {
    chats: [{
      id: 'chat-a', projectId: 'project-a', provider: 'codex',
      messages: [{ role: 'user', turnId: 'turn-12345678', deliveryStatus: 'failed' }],
    }],
  }
  const candidate = runningHostJobCandidates(state.chats, { maximumAttempts: 1 })[0]
  assert.equal(adoptReconnectableHostJobState(state, {
    candidate,
    job: { id: candidate.jobId, state: 'failed' },
    projectPath: '/project-a',
    executionTarget: 'local',
  }), null)
  assert.equal(adoptReconnectableHostJobState(state, {
    candidate,
    job: { id: `${candidate.jobId}-other`, state: 'running' },
    projectPath: '/project-a',
    executionTarget: 'local',
  }), null)
})

test('an exact occupied local Host job can be prepared for surviving-renderer adoption', () => {
  const state = {
    chats: [{
      id: 'chat-a', projectId: 'project-a', provider: 'claude', subtitle: 'Message queued behind active run',
      messages: [
        { role: 'user', turnId: 'turn-12345678', deliveryStatus: 'pending' },
        { role: 'user', turnId: 'turn-queued99', deliveryStatus: 'queued' },
      ],
    }],
    chatErrors: { 'chat-a': 'waiting' },
    chatExecutionEvents: { 'chat-a': [{ type: 'notice', message: 'stale' }] },
    inFlightRuns: {},
  }
  const candidate = {
    chatId: 'chat-a',
    turnId: 'turn-12345678',
    provider: 'claude',
    attempt: 1,
    jobId: 'job-turn-12345678-claude-1',
  }
  const owner = {
    ownerJobId: candidate.jobId,
    turnId: candidate.turnId,
    provider: candidate.provider,
    targetKind: 'local',
    nativeWorkspaceId: '11111111-1111-4111-8111-111111111111',
    projectId: 'project-a',
    projectPath: 'C:\\Users\\example\\project-a',
    chatId: candidate.chatId,
    predecessorTranscriptFingerprint,
  }
  const recovered = adoptReconnectableHostJobState(state, {
    candidate,
    job: {
      id: candidate.jobId, kind: 'local', state: 'completed', startedAt: '2026-09-02T22:13:11.500Z',
      finishedAt: '2026-09-02T22:54:24.000Z', firstSequence: 1, lastSequence: 12,
      providerProcessStarted: true, steerable: false, pendingQuestions: [],
    },
    projectPath: owner.projectPath,
    executionTarget: 'local',
    predecessorTranscriptFingerprint,
    occupied: {
      owner,
      replacementWorkspaceId: '22222222-2222-4222-8222-222222222222',
    },
  })

  assert.ok(recovered)
  assert.equal(recovered.inFlightRun.jobId, candidate.jobId)
  assert.equal(recovered.chats[0].messages[0].deliveryStatus, 'pending')
  assert.equal(recovered.chats[0].messages[1].deliveryStatus, 'queued')
})

test('occupied Host job adoption fails closed on identity, target, or transcript mismatch', () => {
  const candidate = {
    chatId: 'chat-a', turnId: 'turn-12345678', provider: 'claude', attempt: 1,
    jobId: 'job-turn-12345678-claude-1',
  }
  const owner = {
    ownerJobId: candidate.jobId,
    turnId: candidate.turnId,
    provider: candidate.provider,
    targetKind: 'local',
    nativeWorkspaceId: '11111111-1111-4111-8111-111111111111',
    projectId: 'project-a',
    projectPath: '/project-a',
    chatId: candidate.chatId,
    predecessorTranscriptFingerprint,
  }
  const job = {
    id: candidate.jobId, kind: 'local', state: 'running', startedAt: '2026-09-02T22:13:11.500Z',
    finishedAt: null, firstSequence: 1, lastSequence: 12,
    providerProcessStarted: true, steerable: false, pendingQuestions: [],
  }
  const baseState = {
    chats: [{
      id: 'chat-a', projectId: 'project-a', provider: 'claude',
      messages: [{ role: 'user', turnId: candidate.turnId, deliveryStatus: 'pending' }],
    }],
    inFlightRuns: {},
  }
  const recover = ({
    state = baseState,
    candidateOverride = {},
    ownerOverride = {},
    jobOverride = {},
    target = 'local',
    fingerprint = predecessorTranscriptFingerprint,
  } = {}) =>
    adoptReconnectableHostJobState(state, {
      candidate: { ...candidate, ...candidateOverride },
      job: { ...job, ...jobOverride },
      projectPath: '/project-a',
      executionTarget: target,
      predecessorTranscriptFingerprint: fingerprint,
      occupied: {
        owner: { ...owner, ...ownerOverride },
        replacementWorkspaceId: '22222222-2222-4222-8222-222222222222',
      },
    })

  const cases = [
    { ownerOverride: { ownerJobId: 'job-turn-12345678-claude-2' } },
    { ownerOverride: { turnId: 'turn-other999' } },
    { ownerOverride: { provider: 'codex' } },
    { ownerOverride: { targetKind: 'ssh' } },
    { ownerOverride: { nativeWorkspaceId: 'not-a-workspace' } },
    { ownerOverride: { projectId: 'project-b' } },
    { ownerOverride: { projectPath: '/project-b' } },
    { ownerOverride: { chatId: 'chat-b' } },
    { ownerOverride: { predecessorTranscriptFingerprint: null } },
    { ownerOverride: { predecessorTranscriptFingerprint: 'b'.repeat(64) } },
    { fingerprint: null },
    { fingerprint: 'b'.repeat(64) },
    { jobOverride: { id: 'job-turn-12345678-claude-2' } },
    { jobOverride: { kind: 'ssh' } },
    { candidateOverride: { provider: 'codex' } },
    { target: 'ssh:remote' },
    { state: { ...baseState, inFlightRuns: { 'chat-a': { jobId: 'job-existing' } } } },
    { state: { ...baseState, chats: [{ ...baseState.chats[0], projectId: 'project-b' }] } },
    { state: { ...baseState, chats: [{ ...baseState.chats[0], messages: [] }] } },
    { state: { ...baseState, chats: [{
      ...baseState.chats[0],
      messages: [
        ...baseState.chats[0].messages,
        { role: 'agent', turnId: candidate.turnId, deliveryStatus: 'completed' },
      ],
    }] } },
  ]

  for (const mismatch of cases) assert.equal(recover(mismatch), null)
})

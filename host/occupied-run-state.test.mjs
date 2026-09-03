import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptTransferredPrompt,
  promoteQueuedMessageToActiveTurn,
  promoteQueuedPromptToActiveTurn,
} from '../src/lib/promptQueue.mjs'
import {
  activeNativeRunBindings,
  applyOccupiedJobObservation,
  commitHandoffAcceptance,
  completedNativeRunBinding,
  convertPendingTurnToOccupiedQueue,
  exactNativeFocusCanApply,
  handoffEntryForAction,
  normalizeOccupiedRuns,
  occupiedRunControls,
  occupiedQueueSnapshotForAttempt,
  reconcileQueuedMessageHandoff,
  validateTerminalQueuedMessageHandoff,
  validateQueuedMessageHandoff,
} from '../src/lib/occupiedRunState.mjs'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const predecessorTranscriptFingerprint = 'a'.repeat(64)
const owner = {
  jobId: 'job-owner-1234567890',
  turnId: 'turn-owner',
  provider: 'codex',
  targetKind: 'local',
  startedAt: '2026-08-11T10:00:00.000Z',
  providerProcessStarted: true,
  steerable: true,
  nativeWorkspaceId: workspaceId,
  predecessorTranscriptFingerprint,
}
const preferences = {
  providerMode: 'auto',
  provider: 'codex',
  sizeTier: null,
  automaticFallback: true,
  autoContextSkill: true,
  fallbackProviderOrder: ['codex', 'claude'],
  executionTargetKey: 'local',
  projectId: 'relay',
  projectPath: '/Users/example/relay',
}

test('a re-occupied drained FIFO head preserves its original identity and preferences verbatim', () => {
  const queuedPrompt = {
    id: 'stable-handoff-id',
    messageId: 'stable-message-id',
    enqueuedAt: '2026-08-10T09:00:00.000Z',
    preferences,
  }
  const selected = occupiedQueueSnapshotForAttempt(queuedPrompt, {
    queueId: 'new-id',
    messageId: 'new-message',
    enqueuedAt: '2026-08-11T12:00:00.000Z',
    preferences: { ...preferences, provider: 'claude', projectPath: '/different' },
  })
  assert.deepEqual(selected, {
    queueId: queuedPrompt.id,
    messageId: queuedPrompt.messageId,
    enqueuedAt: queuedPrompt.enqueuedAt,
    preferences,
  })
  assert.strictEqual(selected.preferences, queuedPrompt.preferences)
})

test('persisted occupied owners are bounded and reject extra sensitive fields', () => {
  assert.deepEqual(normalizeOccupiedRuns({
    'chat-a': {
      ownerJobId: owner.jobId,
      turnId: owner.turnId,
      provider: owner.provider,
      targetKind: owner.targetKind,
      startedAt: owner.startedAt,
      providerProcessStarted: true,
      steerable: true,
      nativeWorkspaceId: workspaceId,
      predecessorTranscriptFingerprint,
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'chat-a',
      controllable: true,
      prompt: 'must not persist',
      attachmentPaths: ['/secret'],
    },
  }), {
    'chat-a': {
      ownerJobId: owner.jobId,
      turnId: owner.turnId,
      provider: owner.provider,
      targetKind: owner.targetKind,
      startedAt: owner.startedAt,
      providerProcessStarted: true,
      steerable: true,
      nativeWorkspaceId: workspaceId,
      predecessorTranscriptFingerprint,
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'chat-a',
      controllable: false,
    },
  })
  assert.deepEqual(normalizeOccupiedRuns({ bad: { ...owner, projectId: 'relay' } }), {})
})

test('occupied admission converts the already-visible pending turn into one stable FIFO entry', () => {
  const result = convertPendingTurnToOccupiedQueue({
    chats: [{
      id: 'chat-a',
      messages: [{
        id: 'msg-turn-second',
        role: 'user',
        content: 'new message',
        time: '12:00',
        turnId: 'turn-second',
        deliveryStatus: 'pending',
        attachments: [{ name: 'one.txt', path: '/tmp/one.txt' }],
      }],
    }],
    queues: {},
    inFlightRuns: { 'chat-a': { turnId: 'turn-second', jobId: 'job-second-1234567890' } },
    occupiedRuns: {},
    chatId: 'chat-a',
    queueId: 'handoff-stable-second',
    turnId: 'turn-second',
    messageId: 'msg-turn-second',
    prompt: 'new message',
    attachments: [{ name: 'one.txt', path: '/tmp/one.txt' }],
    enqueuedAt: '2026-08-11T12:00:00.000Z',
    preferences,
    owner,
    binding: {
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'chat-a',
    },
  })

  assert.equal(result.status, 'converted')
  assert.deepEqual(result.inFlightRuns, {})
  assert.equal(result.chats[0].messages[0].deliveryStatus, 'queued')
  assert.deepEqual(result.queues['chat-a'].map((entry) => entry.id), ['handoff-stable-second'])
  assert.equal(result.queues['chat-a'][0].predecessorTurnId, 'turn-owner')
  assert.deepEqual(result.queues['chat-a'][0].attachments, [{ name: 'one.txt', path: '/tmp/one.txt' }])
  assert.deepEqual(result.occupiedRuns['chat-a'], {
    ownerJobId: 'job-owner-1234567890',
    turnId: 'turn-owner',
    provider: 'codex',
    targetKind: 'local',
    startedAt: '2026-08-11T10:00:00.000Z',
    providerProcessStarted: true,
    steerable: true,
    nativeWorkspaceId: workspaceId,
    predecessorTranscriptFingerprint,
    projectId: 'relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-a',
    controllable: false,
  })

  const retried = convertPendingTurnToOccupiedQueue({
    ...result,
    chatId: 'chat-a',
    queueId: 'handoff-stable-second',
    turnId: 'turn-second',
    messageId: 'msg-turn-second',
    prompt: 'new message',
    attachments: [{ name: 'one.txt', path: '/tmp/one.txt' }],
    enqueuedAt: '2026-08-11T12:00:00.000Z',
    preferences,
    owner,
    binding: { projectId: 'relay', projectPath: '/Users/example/relay', chatId: 'chat-a' },
  })
  assert.equal(retried.status, 'duplicate')
  assert.equal(retried.queues['chat-a'].length, 1)
})

test('legacy or malformed occupied owners cannot acquire a transcript adoption binding', () => {
  const normalized = normalizeOccupiedRuns({
    legacy: {
      ownerJobId: owner.jobId,
      turnId: owner.turnId,
      provider: owner.provider,
      targetKind: owner.targetKind,
      startedAt: owner.startedAt,
      nativeWorkspaceId: workspaceId,
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'legacy',
    },
    malformed: {
      ownerJobId: owner.jobId,
      turnId: owner.turnId,
      provider: owner.provider,
      targetKind: owner.targetKind,
      startedAt: owner.startedAt,
      nativeWorkspaceId: workspaceId,
      predecessorTranscriptFingerprint: 'not-a-digest',
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'malformed',
    },
  })
  assert.equal(normalized.legacy.predecessorTranscriptFingerprint, null)
  assert.equal(normalized.malformed.predecessorTranscriptFingerprint, null)
})

test('occupied admission accepts the shared 100,000-character prompt bound and rejects one over', () => {
  const convert = (length) => convertPendingTurnToOccupiedQueue({
    chats: [{
      id: 'chat-long',
      messages: [{
        id: 'message-long',
        role: 'user',
        content: 'x'.repeat(length),
        turnId: 'turn-long',
        deliveryStatus: 'pending',
      }],
    }],
    queues: {},
    inFlightRuns: {},
    occupiedRuns: {},
    chatId: 'chat-long',
    turnId: 'turn-long',
    messageId: 'message-long',
    prompt: 'x'.repeat(length),
    attachments: [],
    enqueuedAt: '2026-08-11T12:00:00.000Z',
    preferences,
    owner,
    binding: { projectId: 'relay', projectPath: '/Users/example/relay', chatId: 'chat-long' },
  })

  assert.equal(convert(5_000).status, 'converted')
  assert.equal(convert(100_000).status, 'converted')
  assert.equal(convert(100_001).status, 'invalid')
})

test('cross-Host occupied admission still queues but exposes no predecessor-authorized controls', () => {
  const result = convertPendingTurnToOccupiedQueue({
    chats: [{ id: 'chat-a', messages: [{ id: 'message', role: 'user', turnId: 'turn-second', deliveryStatus: 'pending' }] }],
    queues: {},
    inFlightRuns: { 'chat-a': { turnId: 'turn-second' } },
    occupiedRuns: {},
    chatId: 'chat-a',
    turnId: 'turn-second',
    messageId: 'message',
    prompt: 'new message',
    attachments: [],
    enqueuedAt: '2026-08-11T12:00:00.000Z',
    preferences,
    owner: { ...owner, turnId: null },
    binding: { projectId: 'relay', projectPath: '/Users/example/relay', chatId: 'chat-a' },
  })
  assert.equal(result.status, 'converted')
  assert.equal(result.chats[0].messages[0].deliveryStatus, 'queued')
  assert.equal(result.queues['chat-a'][0].predecessorTurnId, null)
  assert.equal(result.occupiedRuns['chat-a'].turnId, null)
  assert.equal(occupiedRunControls(result.occupiedRuns['chat-a'], result.queues['chat-a'][0], null, {
    nativeAvailable: true,
  }).canPush, false)
})

test('occupied controls require exact native and same-Host authority', () => {
  const occupied = {
    ownerJobId: owner.jobId,
    turnId: owner.turnId,
    provider: 'codex',
    targetKind: 'local',
    startedAt: owner.startedAt,
    providerProcessStarted: true,
    steerable: true,
    nativeWorkspaceId: workspaceId,
    projectId: 'relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-a',
    controllable: true,
  }
  const entry = {
    id: 'queue-turn-second',
    turnId: 'turn-second',
    messageId: 'msg-turn-second',
    prompt: 'new message',
    enqueuedAt: '2026-08-11T12:00:00.000Z',
    predecessorTurnId: 'turn-owner',
    preferences,
  }
  const binding = {
    workspaceId,
    jobId: owner.jobId,
    turnId: owner.turnId,
    provider: 'codex',
    targetKind: 'local',
    projectId: 'relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-a',
  }

  assert.deepEqual(occupiedRunControls(occupied, entry, binding, {
    nativeAvailable: true,
    shellReachable: true,
  }), {
    canView: true,
    canPush: true,
    canStopAndSend: false,
    reason: null,
  })
  assert.equal(occupiedRunControls({ ...occupied, turnId: null }, entry, binding, {
    nativeAvailable: true,
    shellReachable: true,
  }).canView, false)
  assert.equal(occupiedRunControls(occupied, entry, binding, {
    nativeAvailable: true,
    shellReachable: false,
  }).canView, false)
  assert.equal(occupiedRunControls({ ...occupied, provider: 'claude', steerable: false }, {
    ...entry,
    preferences: { ...preferences, provider: 'claude' },
  }, { ...binding, provider: 'claude' }, {
    nativeAvailable: true,
    shellReachable: true,
  }).canStopAndSend, true)
  assert.equal(occupiedRunControls({
    ...occupied,
    provider: 'claude',
    providerProcessStarted: false,
    steerable: false,
  }, {
    ...entry,
    preferences: { ...preferences, provider: 'claude' },
  }, { ...binding, provider: 'claude' }, {
    nativeAvailable: true,
    shellReachable: true,
  }).canStopAndSend, false)
  assert.equal(occupiedRunControls({
    ...occupied,
    provider: 'claude',
    targetKind: 'ssh',
    steerable: false,
  }, {
    ...entry,
    preferences: { ...preferences, provider: 'claude', executionTargetKey: 'ssh' },
  }, { ...binding, provider: 'claude', targetKind: 'ssh' }, {
    nativeAvailable: true,
    shellReachable: true,
  }).canStopAndSend, false)
  assert.deepEqual(
    occupiedRunControls(occupied, entry, binding, { nativeAvailable: false }),
    {
      canView: false,
      canPush: false,
      canStopAndSend: false,
      reason: 'Open the native Ensync app on this Host to view or control the active run. This message remains queued.',
    },
  )
  assert.equal(occupiedRunControls({ ...occupied, controllable: false }, entry, binding, {
    nativeAvailable: true,
    shellReachable: true,
  }).canPush, false)
  assert.match(occupiedRunControls({ ...occupied, controllable: false }, entry, binding, {
    nativeAvailable: true,
    shellReachable: true,
  }).reason, /another Host|cannot be controlled/i)
})

test('Stop handoff approval changes only the payload and target-first persistence gates state apply', () => {
  const source = {
    id: 'queue-turn-second',
    turnId: 'turn-second',
    messageId: 'msg-turn-second',
    prompt: 'new message',
    attachments: [],
    enqueuedAt: '2026-08-11T12:00:00.000Z',
    predecessorTurnId: owner.turnId,
    preferences,
  }
  const before = JSON.stringify(source)
  const payload = handoffEntryForAction(source, true, '2026-08-11T12:01:00.000Z')
  assert.equal(JSON.stringify(source), before)
  assert.notStrictEqual(payload, source)
  assert.equal(payload.resumeApprovedAt, '2026-08-11T12:01:00.000Z')

  const accepted = { status: 'accepted', chats: [{ id: 'chat-a' }], queues: { 'chat-a': [payload] } }
  const failedOrder = []
  assert.equal(commitHandoffAcceptance(accepted, () => {
    failedOrder.push('persist')
    return false
  }, () => failedOrder.push('apply')), false)
  assert.deepEqual(failedOrder, ['persist'])

  const successfulOrder = []
  assert.equal(commitHandoffAcceptance(accepted, () => {
    successfulOrder.push('persist')
    return true
  }, () => successfulOrder.push('apply')), true)
  assert.deepEqual(successfulOrder, ['persist', 'apply'])
})

test('every exact local terminal outcome retains the same bounded predecessor evidence', () => {
  const run = {
    jobId: owner.jobId,
    turnId: owner.turnId,
    provider: 'codex',
    executionTarget: 'local',
    projectId: 'relay',
    projectPath: '/Users/example/relay',
  }
  for (const terminalOutcome of ['completed', 'failed', 'cancelled', 'reconciliation_required']) {
    assert.deepEqual(completedNativeRunBinding(workspaceId, 'chat-a', {
      ...run,
      terminalOutcome,
    }), {
      workspaceId,
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'chat-a',
      jobId: owner.jobId,
      turnId: owner.turnId,
      provider: 'codex',
      executionTarget: 'local',
    })
  }
  assert.equal(completedNativeRunBinding(workspaceId, 'chat-a', {
    ...run,
    executionTarget: 'ssh:worker',
  }), null)
})

test('Host observations refresh only running controls and never consume the queued prompt', () => {
  const occupiedRuns = {
    'chat-a': {
      ownerJobId: owner.jobId,
      turnId: owner.turnId,
      provider: 'codex',
      targetKind: 'local',
      startedAt: owner.startedAt,
      providerProcessStarted: false,
      steerable: false,
      nativeWorkspaceId: workspaceId,
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'chat-a',
      controllable: true,
    },
  }
  assert.deepEqual(applyOccupiedJobObservation(occupiedRuns, 'chat-a', {
    kind: 'running', providerProcessStarted: true, steerable: true,
  })['chat-a'], {
    ...occupiedRuns['chat-a'], controllable: true, providerProcessStarted: true, steerable: true,
  })
  assert.deepEqual(applyOccupiedJobObservation(occupiedRuns, 'chat-a', { kind: 'unavailable' })['chat-a'], {
    ...occupiedRuns['chat-a'], controllable: false, providerProcessStarted: false, steerable: false,
  })
  assert.equal(applyOccupiedJobObservation(occupiedRuns, 'chat-a', { kind: 'terminal' })['chat-a'], undefined)
})

test('native publication and focus use exact project, chat, and job bindings', () => {
  const bindings = activeNativeRunBindings({
    'chat-a': {
      jobId: owner.jobId,
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      executionTarget: 'local',
    },
    'chat-b': { projectId: 'relay', projectPath: '/Users/example/relay' },
    'chat-ssh': {
      jobId: 'job-remote-1234567890',
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      executionTarget: 'ssh:worker',
    },
  }, workspaceId)
  assert.deepEqual(bindings, [{
    workspaceId,
    projectId: 'relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-a',
    jobId: owner.jobId,
  }])
  assert.equal(exactNativeFocusCanApply(bindings[0], {
    workspaceId,
    projectId: 'relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-a',
    jobId: owner.jobId,
  }), true)
  assert.equal(exactNativeFocusCanApply(bindings[0], { ...bindings[0], jobId: 'job-stale-123456789' }), false)
})

test('handoff target validates exact active predecessor, provider, project, target, and FIFO state', () => {
  const request = {
    handoffId: 'queue-turn-second',
    target: {
      workspaceId,
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'chat-a',
      jobId: owner.jobId,
    },
    entry: {
      id: 'queue-turn-second',
      turnId: 'turn-second',
      messageId: 'msg-turn-second',
      prompt: 'new message',
      enqueuedAt: '2026-08-11T12:00:00.000Z',
      predecessorTurnId: owner.turnId,
      preferences,
    },
  }
  const context = {
    workspaceId,
    projectId: 'relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-a',
    activeRun: {
      turnId: owner.turnId,
      jobId: owner.jobId,
      provider: 'codex',
      executionTarget: 'local',
      projectId: 'relay',
      projectPath: '/Users/example/relay',
    },
    queue: [],
  }
  assert.equal(validateQueuedMessageHandoff(request, context), true)
  assert.equal(validateQueuedMessageHandoff(request, { ...context, queue: [request.entry] }), true)
  assert.equal(validateQueuedMessageHandoff({
    ...request,
    entry: { ...request.entry, resumeApprovedAt: '2026-08-11T12:01:00.000Z' },
  }, { ...context, queue: [request.entry] }), false)
  assert.equal(validateQueuedMessageHandoff(request, {
    ...context,
    queue: [request.entry, { ...request.entry, id: 'later', turnId: 'later', messageId: 'later' }],
  }), false)
  assert.equal(validateQueuedMessageHandoff(request, { ...context, activeRun: { ...context.activeRun, jobId: 'job-stale-123456789' } }), false)
  assert.equal(validateQueuedMessageHandoff(request, { ...context, queue: [{ id: 'earlier' }] }), false)

  const targetChats = [{ id: 'chat-a', messages: [{
    id: 'owner-message', role: 'user', turnId: owner.turnId, content: 'active', deliveryStatus: 'pending',
  }] }]
  const accepted = acceptTransferredPrompt({}, targetChats, 'chat-a', request.entry)
  assert.equal(accepted.status, 'accepted')
  const queuePresentWithoutRunEvidence = reconcileQueuedMessageHandoff(request, {
    workspaceId,
    projectId: 'relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-a',
    chats: accepted.chats,
    queues: accepted.queues,
  })
  assert.equal(queuePresentWithoutRunEvidence.status, 'duplicate')
  assert.equal(queuePresentWithoutRunEvidence.alreadyConsumed, false)
  const consumedQueues = promoteQueuedPromptToActiveTurn(accepted.queues, 'chat-a', request.entry.id, owner.turnId)
  const consumedChats = accepted.chats.map((chat) => ({
    ...chat,
    messages: promoteQueuedMessageToActiveTurn(chat.messages, request.entry.messageId, owner.turnId),
  }))
  assert.equal(validateQueuedMessageHandoff(request, { ...context, queue: consumedQueues['chat-a'] ?? [] }), true)
  const duplicate = acceptTransferredPrompt(consumedQueues, consumedChats, 'chat-a', request.entry)
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.alreadyConsumed, true)

  const presentation = {
    workspaceId,
    projectId: 'relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-a',
    chats: consumedChats,
    queues: consumedQueues,
  }
  const firstTerminalAcceptance = reconcileQueuedMessageHandoff(request, {
    ...presentation,
    chats: targetChats,
    queues: {},
  })
  assert.equal(firstTerminalAcceptance.status, 'accepted')
  const reconciled = reconcileQueuedMessageHandoff(request, presentation)
  assert.equal(reconciled.status, 'duplicate')
  assert.equal(reconciled.alreadyConsumed, true)
  assert.equal(validateTerminalQueuedMessageHandoff(request, {
    ...presentation,
    completedRun: {
      workspaceId,
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'chat-a',
      jobId: owner.jobId,
      turnId: owner.turnId,
      provider: 'codex',
      executionTarget: 'local',
    },
  }), true)
  assert.equal(validateTerminalQueuedMessageHandoff(request, {
    ...presentation,
    completedRun: {
      workspaceId,
      projectId: 'relay',
      projectPath: '/Users/example/relay',
      chatId: 'chat-a',
      jobId: 'job-stale-123456789',
      turnId: owner.turnId,
      provider: 'codex',
      executionTarget: 'local',
    },
  }), false)
})

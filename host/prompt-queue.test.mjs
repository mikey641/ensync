import assert from 'node:assert/strict'
import test from 'node:test'

import * as promptQueueContract from '../src/lib/promptQueue.mjs'
import {
  activeCodexTurnCanAcceptSteering,
  appendPromptToQueue,
  approveNextQueuedPrompt,
  insertAgentReplyBeforeLaterQueued,
  liveSteerWasSafelyRejected,
  normalizePromptQueues,
  predecessorTurnIdForPrompt,
  promoteQueuedMessageToActiveTurn,
  promoteQueuedPromptToActiveTurn,
  promptQueueComposerState,
  promptQueueStatusPresentation,
  queuedPromptGate,
  removePromptFromQueue,
  transcriptMessagesBeforeTurn,
} from '../src/lib/promptQueue.mjs'

const entry = (turnId, predecessorTurnId = null) => ({
  id: `queue-${turnId}`,
  turnId,
  messageId: `message-${turnId}`,
  prompt: turnId,
  enqueuedAt: '2026-08-06T12:00:00.000Z',
  predecessorTurnId,
  preferences: { providerMode: 'fixed' },
})

test('per-chat queues preserve FIFO order and independent chat state', () => {
  let queues = appendPromptToQueue({}, 'chat-a', entry('turn-1'))
  queues = appendPromptToQueue(queues, 'chat-a', entry('turn-2', 'turn-1'))
  queues = appendPromptToQueue(queues, 'chat-b', entry('turn-b'))
  assert.deepEqual(queues['chat-a'].map((item) => item.turnId), ['turn-1', 'turn-2'])
  assert.deepEqual(queues['chat-b'].map((item) => item.turnId), ['turn-b'])
  queues = removePromptFromQueue(queues, 'chat-a', 'queue-turn-1')
  assert.deepEqual(queues['chat-a'].map((item) => item.turnId), ['turn-2'])
  assert.deepEqual(queues['chat-b'].map((item) => item.turnId), ['turn-b'])
})

test('confirmed live delivery consumes only the head and rebases its FIFO successor', () => {
  const queues = {
    'chat-a': [
      entry('turn-2', 'turn-1'),
      entry('turn-3', 'turn-2'),
      entry('turn-4', 'turn-3'),
    ],
  }
  const promoted = promoteQueuedPromptToActiveTurn(queues, 'chat-a', 'queue-turn-2', 'turn-1')
  assert.deepEqual(promoted['chat-a'].map((item) => [item.turnId, item.predecessorTurnId]), [
    ['turn-3', 'turn-1'],
    ['turn-4', 'turn-3'],
  ])
  assert.equal(
    promoteQueuedPromptToActiveTurn(queues, 'chat-a', 'queue-turn-3', 'turn-1'),
    queues,
  )
})

test('confirmed queued messages join the active turn without crossing its reply', () => {
  const pendingMessages = [
    { id: 'u1', role: 'user', turnId: 'turn-1', deliveryStatus: 'pending' },
    { id: 'u2', role: 'user', turnId: 'turn-2', deliveryStatus: 'queued' },
    { id: 'u3', role: 'user', turnId: 'turn-3', deliveryStatus: 'queued' },
  ]
  const pending = promoteQueuedMessageToActiveTurn(pendingMessages, 'u2', 'turn-1')
  assert.deepEqual(pending.map((message) => [message.id, message.turnId, message.deliveryStatus]), [
    ['u1', 'turn-1', 'pending'],
    ['u2', 'turn-1', 'pending'],
    ['u3', 'turn-3', 'queued'],
  ])

  const completed = promoteQueuedMessageToActiveTurn([
    pendingMessages[0],
    { id: 'a1', role: 'agent', turnId: 'turn-1' },
    pendingMessages[1],
    pendingMessages[2],
  ], 'u2', 'turn-1')
  assert.deepEqual(completed.map((message) => message.id), ['u1', 'u2', 'a1', 'u3'])
  assert.equal(completed[1].deliveryStatus, 'completed')
})

test('automatic queue advancement requires a matching verified reply', () => {
  const queued = entry('turn-2', 'turn-1')
  const pending = { messages: [{ role: 'user', turnId: 'turn-1', deliveryStatus: 'pending' }] }
  const failed = { messages: [{ role: 'user', turnId: 'turn-1', deliveryStatus: 'failed' }] }
  const incomplete = { messages: [{ role: 'user', turnId: 'turn-1', deliveryStatus: 'completed' }] }
  const completed = { messages: [
    { role: 'user', turnId: 'turn-1', deliveryStatus: 'completed' },
    { role: 'agent', turnId: 'turn-1' },
  ] }
  assert.equal(queuedPromptGate(pending, queued).state, 'waiting')
  assert.equal(queuedPromptGate(failed, queued).state, 'paused')
  assert.equal(queuedPromptGate(incomplete, queued).state, 'paused')
  assert.equal(queuedPromptGate(completed, queued).state, 'ready')
})

test('explicit review approval releases only the next prompt', () => {
  const queues = { 'chat-a': [entry('turn-2', 'turn-1'), entry('turn-3', 'turn-2')] }
  const approved = approveNextQueuedPrompt(queues, 'chat-a', '2026-08-06T12:01:00.000Z')
  assert.equal(queuedPromptGate({ messages: [] }, approved['chat-a'][0]).state, 'ready')
  assert.equal(approved['chat-a'][1].resumeApprovedAt, undefined)
})

test('queue status explains the safety pause and the exact action in plain language', () => {
  assert.deepEqual(promptQueueStatusPresentation({
    state: 'paused',
    reason: 'The preceding turn failed.',
  }, 1), {
    headline: '1 message paused',
    detail: 'The preceding turn failed. Review possible partial project changes before continuing. Running the next message will not retry the previous turn.',
    actionLabel: 'Run next message anyway',
  })
  assert.deepEqual(promptQueueStatusPresentation({ state: 'waiting', reason: null }, 2), {
    headline: '2 messages queued',
    detail: 'It will run automatically after the current turn finishes successfully.',
    actionLabel: null,
  })
})

test('execution context stops before its own prompt and replies precede future queued prompts', () => {
  const messages = [
    { id: 'u1', role: 'user', turnId: 'turn-1', deliveryStatus: 'completed' },
    { id: 'a1', role: 'agent', turnId: 'turn-1' },
    { id: 'u2', role: 'user', turnId: 'turn-2', deliveryStatus: 'pending' },
    { id: 'u3', role: 'user', turnId: 'turn-3', deliveryStatus: 'queued' },
  ]
  assert.deepEqual(transcriptMessagesBeforeTurn(messages, 'turn-2').map((message) => message.id), ['u1', 'a1'])
  const ordered = insertAgentReplyBeforeLaterQueued(messages, 'turn-2', { id: 'a2', role: 'agent', turnId: 'turn-2' })
  assert.deepEqual(ordered.map((message) => message.id), ['u1', 'a1', 'u2', 'a2', 'u3'])
})

test('predecessors chain through the active turn and then queued tail', () => {
  assert.equal(predecessorTurnIdForPrompt([], [], { turnId: 'active' }), 'active')
  assert.equal(predecessorTurnIdForPrompt([entry('queued')], [], { turnId: 'active' }), 'queued')
})

test('live steering is offered only for the exact Host-started local Codex turn', () => {
  const queued = {
    ...entry('turn-2', 'turn-1'),
    preferences: {
      ...entry('turn-2', 'turn-1').preferences,
      executionTargetKey: 'local',
      projectId: 'project-1',
      projectPath: '/repo',
    },
  }
  const activeRun = {
    turnId: 'turn-1',
    provider: 'codex',
    executionTarget: 'local',
    providerProcessStarted: false,
    jobId: 'job-turn-1-codex-1',
    projectId: 'project-1',
    projectPath: '/repo',
  }

  assert.equal(activeCodexTurnCanAcceptSteering(activeRun), false)
  assert.equal(queuedPromptCanSteerActiveTurn(queued, activeRun), false)

  const startedRun = { ...activeRun, providerProcessStarted: true }
  assert.equal(activeCodexTurnCanAcceptSteering(startedRun), true)
  assert.equal(queuedPromptCanSteerActiveTurn(queued, startedRun), true)
  assert.equal(queuedPromptCanSteerActiveTurn(queued, { ...startedRun, projectPath: '/other' }), false)
})

test('only a confirmed unavailable live turn silently falls back to FIFO', () => {
  assert.equal(liveSteerWasSafelyRejected({
    code: 'live_steer_unavailable',
    safeToRetry: true,
  }), true)
  assert.equal(liveSteerWasSafelyRejected({
    code: 'live_steer_unconfirmed',
    safeToRetry: false,
  }), false)
  assert.equal(liveSteerWasSafelyRejected({
    code: 'invalid_prompt',
    safeToRetry: true,
  }), false)
})

test('normalization keeps only structurally complete persisted entries', () => {
  const queues = normalizePromptQueues({
    good: [{ ...entry('turn-1'), attachments: [
      { name: 'reference.png', path: '/tmp/reference.png' },
      { name: 'duplicate.png', path: '/tmp/reference.png' },
    ] }],
    bad: [{ id: 'missing-fields' }],
  })
  assert.deepEqual(Object.keys(queues), ['good'])
  assert.deepEqual(queues.good[0].attachments, [
    { name: 'reference.png', path: '/tmp/reference.png' },
  ])
})

test('composer keeps separate Stop and enabled Send controls while a chat is running', () => {
  assert.deepEqual(promptQueueComposerState({ sending: true, draft: 'next prompt', canRun: true }), {
    sendEnabled: true,
    sendLabel: 'Queue message in this chat',
    sendText: null,
    stopVisible: true,
    hint: '↵ queue · stop ends current only',
  })
  assert.equal(promptQueueComposerState({ sending: true, draft: '   ', canRun: true }).sendEnabled, false)
})

test('active-run submissions always queue before an explicit Push now action', () => {
  assert.equal(promptQueueContract.promptSubmissionMode?.({ hasActiveRun: true }), 'queue')
  assert.deepEqual(promptQueueComposerState({
    sending: true,
    draft: 'correct the active task',
    canRun: true,
    liveSteering: true,
  }), {
    sendEnabled: true,
    sendLabel: 'Queue message in this chat',
    stopVisible: true,
    hint: '↵ queue · stop ends current only',
  })
})

test('live push readiness follows only Host-authored ready and closed events', () => {
  assert.equal(liveSteerReadyAfterEvent(false, { type: 'started' }), false)
  assert.equal(liveSteerReadyAfterEvent(false, { type: 'notice', code: 'live_steer_ready' }), true)
  assert.equal(liveSteerReadyAfterEvent(true, { type: 'note' }), true)
  assert.equal(liveSteerReadyAfterEvent(true, { type: 'notice', code: 'live_steer_closed' }), false)
  assert.equal(liveSteerReadyAfterEvent(true, { type: 'finished' }), false)
})

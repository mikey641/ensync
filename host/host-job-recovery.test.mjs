import assert from 'node:assert/strict'
import test from 'node:test'

import {
  adoptReconnectableHostJobState,
  runningHostJobCandidates,
} from '../src/lib/hostJobRecovery.mjs'

test('renderer state loss probes only deterministic recent Host job identities', () => {
  const chats = [{
    id: 'chat-a',
    provider: 'codex',
    messages: [
      { role: 'user', turnId: 'legacy', deliveryStatus: 'failed' },
      { role: 'user', turnId: 'turn-12345678', deliveryStatus: 'failed' },
    ],
  }]

  assert.deepEqual(runningHostJobCandidates(chats, { maximumAttempts: 2 }), [
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'codex', attempt: 1, jobId: 'job-turn-12345678-codex-1' },
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'codex', attempt: 2, jobId: 'job-turn-12345678-codex-2' },
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'claude', attempt: 1, jobId: 'job-turn-12345678-claude-1' },
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'claude', attempt: 2, jobId: 'job-turn-12345678-claude-2' },
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'droid', attempt: 1, jobId: 'job-turn-12345678-droid-1' },
    { chatId: 'chat-a', turnId: 'turn-12345678', provider: 'droid', attempt: 2, jobId: 'job-turn-12345678-droid-2' },
  ])
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

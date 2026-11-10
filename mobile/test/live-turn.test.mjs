import assert from 'node:assert/strict'
import test from 'node:test'

import { DELIVERY_STEPS, deliveryLabel, deliveryPosition, deliveryTone, latestDelivery } from '../src/delivery.js'
import {
  canSteer,
  chatIsRunning,
  documentProgress,
  jobNotes,
  jobProgress,
  jobQueued,
  queuedMessageIds,
  runningTarget,
  workingLabel,
} from '../src/live-turn.js'
import { applyPendingOps, turnRequest } from '../src/workspace.js'

const STARTED = '2026-11-09T10:00:00.000Z'
const NOW = Date.parse('2026-11-09T10:01:22.000Z')

function liveTurn(extra = {}) {
  return {
    turnId: 'turn-1', status: 'running', provider: 'claude', startedAt: STARTED,
    updatedAt: '2026-11-09T10:01:10.000Z', origin: 'desktop',
    notes: [{ provider: 'claude', text: 'Searching for where Facebook post text is composed.', redacted: false, at: '2026-11-09T10:01:10.000Z' }],
    ...extra,
  }
}

function chat(extra = {}) {
  return {
    id: 'chat-1', projectId: 'p1', title: 'Post text', provider: 'claude',
    messages: [{ id: 'u1', role: 'user', turnId: 'turn-1', content: 'where is it composed?', time: '10:00' }],
    ...extra,
  }
}

test('the working label matches the desktop, minutes and seconds', () => {
  assert.equal(workingLabel(STARTED, NOW), 'Working (1m 22s)')
  assert.equal(workingLabel(STARTED, Date.parse(STARTED) + 9_000), 'Working (9s)')
  assert.equal(workingLabel('not a date', NOW), 'Working…')
})

test('a desktop turn shows its notes and working line, and marks the chat running', () => {
  const conversation = chat({ liveTurn: liveTurn() })
  const progress = documentProgress(conversation, [], NOW)
  assert.equal(progress.provider, 'claude')
  assert.equal(progress.startedAt, STARTED)
  assert.deepEqual(progress.notes.map((note) => note.text), ['Searching for where Facebook post text is composed.'])
  assert.equal(chatIsRunning(conversation, [], NOW), true)
  assert.equal(chatIsRunning(chat(), [], NOW), false)
})

test('nothing is shown once the reply lands or the writer goes quiet', () => {
  const finished = chat({
    liveTurn: liveTurn(),
    messages: [
      { id: 'u1', role: 'user', turnId: 'turn-1', content: 'q', time: '10:00', deliveryStatus: 'completed' },
      { id: 'a1', role: 'agent', turnId: 'turn-1', content: 'done', time: '10:02' },
    ],
  })
  assert.equal(documentProgress(finished, [], NOW), null)
  assert.equal(chatIsRunning(finished, [], NOW), false)
  const stale = chat({ liveTurn: liveTurn() })
  assert.equal(documentProgress(stale, [], NOW + 10 * 60_000), null)
})

test('a phone job shows its own notes, never terminal output, and the mirror does not duplicate it', () => {
  const job = {
    jobId: 'job_1', chatId: 'chat-1', messageId: 'm1', state: 'running', submitted: true,
    request: { provider: 'codex' }, createdAt: STARTED,
    events: [
      { type: 'started', at: '2026-11-09T10:00:02.000Z' },
      { type: 'output', text: 'secret stdout' },
      { type: 'note', provider: 'codex', text: 'Reading main.js', redacted: false, at: '2026-11-09T10:00:05.000Z' },
    ],
  }
  const mirrored = chat({ liveTurn: liveTurn({ turnId: 'm1', messageId: 'm1', jobId: 'job_1', origin: 'host', provider: 'codex' }) })
  assert.deepEqual(jobNotes(job).map((note) => note.text), ['Reading main.js'])
  const progress = jobProgress(job, mirrored, NOW)
  assert.equal(progress.provider, 'codex')
  assert.equal(progress.startedAt, STARTED)
  assert.deepEqual(progress.notes.map((note) => note.text), ['Reading main.js'])
  assert.doesNotMatch(JSON.stringify(progress), /secret stdout/)
  // The job card already covers this turn, so no second live block renders.
  assert.equal(documentProgress(mirrored, [job], NOW), null)

  // Before the phone receives note events, the Host's mirrored notes fill in.
  const quiet = { ...job, events: [] }
  assert.deepEqual(jobProgress(quiet, mirrored, NOW).notes.map((note) => note.text), ['Searching for where Facebook post text is composed.'])
  // A finished job no longer covers it.
  assert.ok(documentProgress(mirrored, [{ ...job, state: 'completed' }], NOW))
})

test('phone edits keep the mirrored progress and never turn it into a message', () => {
  const base = { format: 'ensync-account-conversations', version: 1, projects: [], chats: [chat({ liveTurn: liveTurn() })] }
  const message = { id: 'msg-2-phone', role: 'user', content: 'also check tests', time: '10:01', origin: 'phone' }
  const next = applyPendingOps(base, [{ chatId: 'chat-1', message }])
  assert.deepEqual(next.chats[0].messages.map((item) => item.id), ['u1', 'msg-2-phone'])
  assert.equal(next.chats[0].liveTurn.turnId, 'turn-1')
})

test('queued prompts from the Host or a desktop window show as Queued until they run', () => {
  const conversation = chat({
    liveTurn: liveTurn({ jobId: 'job_desktop_1', provider: 'codex' }),
    messages: [
      { id: 'u1', role: 'user', turnId: 'turn-1', content: 'q', time: '10:00' },
      { id: 'm-phone', role: 'user', content: 'next', time: '10:01', origin: 'phone' },
      { id: 'u3', role: 'user', turnId: 'turn-3', content: 'later', time: '10:01' },
    ],
    liveQueue: {
      host: { updatedAt: '2026-11-09T10:01:05.000Z', items: [{ messageId: 'm-phone', jobId: 'job_phone_1' }] },
      desktop: { updatedAt: '2026-11-09T10:01:06.000Z', items: [{ messageId: 'u3', turnId: 'turn-3' }] },
    },
  })
  assert.deepEqual([...queuedMessageIds(conversation, NOW)].sort(), ['m-phone', 'u3'])
  const job = { jobId: 'job_phone_1', messageId: 'm-phone', state: 'claimed', submitted: true }
  assert.equal(jobQueued(job, conversation, NOW), true)
  assert.equal(jobQueued({ ...job, state: 'running' }, conversation, NOW), false)
  // Stop/steer address the desktop's Host job when the phone has no running job of its own.
  const target = runningTarget(conversation, [job], NOW)
  assert.deepEqual(target, { kind: 'control', targetJobId: 'job_desktop_1', provider: 'codex' })
  assert.equal(canSteer(target), true)
  assert.equal(canSteer({ kind: 'control', provider: 'claude' }), false)
  const own = runningTarget(conversation, [{ jobId: 'job_mine', state: 'running', submitted: true, request: { provider: 'claude' } }], NOW)
  assert.deepEqual(own, { kind: 'job', jobId: 'job_mine', provider: 'claude' })
})

test('delivery progress mirrors the desktop panel labels and steps', () => {
  assert.equal(deliveryLabel({ state: 'landing', landingState: 'integrating' }), 'Merging by Ensync')
  assert.equal(deliveryLabel({ state: 'building' }), 'Building')
  assert.equal(deliveryLabel({ state: 'production', deliveryTarget: 'protected_branch' }), 'Saved only')
  assert.equal(DELIVERY_STEPS[deliveryPosition({ state: 'pushed' })], 'Pushed')
  assert.equal(DELIVERY_STEPS[deliveryPosition({ state: 'production' })], 'Production')
  assert.equal(deliveryPosition({ state: 'landing', landingState: 'landed' }), 2)
  assert.equal(deliveryTone({ state: 'failed' }), 'error')
  assert.equal(latestDelivery({ records: [{ id: 'a' }, { id: 'b' }] }).id, 'a')
  assert.equal(latestDelivery(null), null)
})

test('a phone turn carries its delivery target, like a desktop prompt', () => {
  const base = { chat: chat(), project: { path: '/p' }, provider: 'claude', prompt: 'go', messageId: 'm1' }
  assert.equal(turnRequest(base).deliveryTarget, 'production')
  assert.equal(turnRequest({ ...base, deliveryTarget: 'protected_branch' }).deliveryTarget, 'protected_branch')
})

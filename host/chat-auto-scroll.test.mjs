import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chatAutoScrollContentRevision,
  chatScrollDistanceFromBottom,
  chatScrollIsNearBottom,
  initialChatAutoScrollState,
  transitionChatAutoScroll,
} from '../src/lib/chatAutoScroll.mjs'

test('near-bottom detection uses the pane viewport metrics and a bounded threshold', () => {
  assert.equal(chatScrollDistanceFromBottom({ scrollHeight: 1_000, scrollTop: 600, clientHeight: 320 }), 80)
  assert.equal(chatScrollIsNearBottom({ scrollHeight: 1_000, scrollTop: 608, clientHeight: 320 }), true)
  assert.equal(chatScrollIsNearBottom({ scrollHeight: 1_000, scrollTop: 607, clientHeight: 320 }), false)
})

test('content follows while pinned, but new activity waits after a deliberate upward scroll', () => {
  const initial = initialChatAutoScrollState()
  const firstContent = transitionChatAutoScroll(initial, { type: 'content' })
  assert.deepEqual(firstContent, {
    state: { pinned: true, pendingLatest: false },
    scrollToLatest: true,
  })

  const unpinned = transitionChatAutoScroll(firstContent.state, {
    type: 'scroll',
    metrics: { scrollHeight: 2_000, scrollTop: 400, clientHeight: 500 },
  })
  assert.deepEqual(unpinned.state, { pinned: false, pendingLatest: false })

  const waiting = transitionChatAutoScroll(unpinned.state, { type: 'content' })
  assert.deepEqual(waiting, {
    state: { pinned: false, pendingLatest: true },
    scrollToLatest: false,
  })
})

test('returning near bottom, pane activation, and explicit jump restore following', () => {
  const waiting = { pinned: false, pendingLatest: true }
  const nearBottom = transitionChatAutoScroll(waiting, {
    type: 'scroll',
    metrics: { scrollHeight: 2_000, scrollTop: 1_435, clientHeight: 500 },
  })
  assert.deepEqual(nearBottom, {
    state: { pinned: true, pendingLatest: false },
    scrollToLatest: false,
  })

  for (const type of ['activate', 'jump']) {
    assert.deepEqual(transitionChatAutoScroll(waiting, { type }), {
      state: { pinned: true, pendingLatest: false },
      scrollToLatest: true,
    })
  }
})

test('split panes keep independent pin and pending-latest policy state', () => {
  const leftPane = transitionChatAutoScroll(initialChatAutoScrollState(), {
    type: 'scroll',
    metrics: { scrollHeight: 1_500, scrollTop: 100, clientHeight: 400 },
  }).state
  const rightPane = initialChatAutoScrollState()

  const leftUpdate = transitionChatAutoScroll(leftPane, { type: 'content' })
  const rightUpdate = transitionChatAutoScroll(rightPane, { type: 'content' })

  assert.deepEqual(leftUpdate, {
    state: { pinned: false, pendingLatest: true },
    scrollToLatest: false,
  })
  assert.deepEqual(rightUpdate, {
    state: { pinned: true, pendingLatest: false },
    scrollToLatest: true,
  })
})

test('semantic revision changes for messages, live CLI output, queue state, and errors', () => {
  const baseline = {
    messages: [{ id: 'm1', role: 'user', content: 'Build it', deliveryStatus: 'pending' }],
    executionEvents: [],
    sending: true,
    queuedPrompts: [],
    error: null,
  }
  const revision = chatAutoScrollContentRevision(baseline)
  assert.notEqual(chatAutoScrollContentRevision({
    ...baseline,
    messages: [{ ...baseline.messages[0], deliveryStatus: 'completed' }],
  }), revision)
  assert.notEqual(chatAutoScrollContentRevision({
    ...baseline,
    executionEvents: [{ type: 'output', stream: 'stdout', text: 'working\n', at: '2026-08-06T12:00:00.000Z' }],
  }), revision)
  assert.notEqual(chatAutoScrollContentRevision({
    ...baseline,
    executionEvents: [{ type: 'note', provider: 'codex', text: 'Inspecting the run.', at: '2026-08-06T12:00:00.000Z' }],
  }), revision)
  assert.notEqual(chatAutoScrollContentRevision({
    ...baseline,
    queuedPrompts: [{ id: 'q1', turnId: 't2' }],
  }), revision)
  assert.notEqual(chatAutoScrollContentRevision({ ...baseline, error: 'Provider stopped.' }), revision)
})

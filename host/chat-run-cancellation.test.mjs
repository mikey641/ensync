import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatRunCancellationRegistry } from '../src/lib/chatRunCancellation.mjs'

test('stopping one conversation aborts only that conversation run', () => {
  const cancellations = createChatRunCancellationRegistry()
  const first = cancellations.begin('chat-a')
  const second = cancellations.begin('chat-b')

  assert.equal(cancellations.stop('chat-a'), true)
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, false)
  assert.equal(cancellations.stop('chat-a'), false)
})

test('a stale run cannot remove a newer cancellation controller for the same chat', () => {
  const cancellations = createChatRunCancellationRegistry()
  const first = cancellations.begin('chat-a')
  const second = cancellations.begin('chat-a')

  assert.equal(cancellations.finish('chat-a', first), false)
  assert.equal(cancellations.stop('chat-a'), true)
  assert.equal(first.signal.aborted, false)
  assert.equal(second.signal.aborted, true)
  assert.equal(cancellations.finish('chat-a', second), true)
})

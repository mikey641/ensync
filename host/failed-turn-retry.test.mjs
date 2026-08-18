import assert from 'node:assert/strict'
import test from 'node:test'

import { retryableFailedTurn } from '../src/lib/failedTurnRetry.mjs'

test('a conversation ending in a failed turn offers that exact instruction again', () => {
  assert.deepEqual(
    retryableFailedTurn([
      { id: 'msg-1', role: 'user', content: 'first', deliveryStatus: 'completed' },
      { id: 'msg-2', role: 'agent', content: 'done' },
      { id: 'msg-3', role: 'user', content: 'fix the wedge', deliveryStatus: 'failed' },
    ]),
    { messageId: 'msg-3', prompt: 'fix the wedge', attachments: [] },
  )
})

test('the attached files of a failed turn come back with it', () => {
  assert.deepEqual(
    retryableFailedTurn([{
      id: 'msg-1',
      role: 'user',
      content: 'review this',
      deliveryStatus: 'failed',
      attachments: [{ name: 'log.txt', path: '/tmp/log.txt' }, { name: 'log.txt', path: '/tmp/log.txt' }],
    }]),
    {
      messageId: 'msg-1',
      prompt: 'review this',
      attachments: [{ name: 'log.txt', path: '/tmp/log.txt' }],
    },
  )
})

test('an attachment-only turn is retried with no prompt, never with its placeholder copy', () => {
  assert.deepEqual(
    retryableFailedTurn([{
      id: 'msg-1',
      role: 'user',
      content: 'Attached 1 file.',
      deliveryStatus: 'failed',
      attachments: [{ name: 'shot.png', path: '/tmp/shot.png' }],
    }]),
    {
      messageId: 'msg-1',
      prompt: '',
      attachments: [{ name: 'shot.png', path: '/tmp/shot.png' }],
    },
  )
})

test('only the last turn is offered, so a failure with work after it is never re-run', () => {
  assert.equal(
    retryableFailedTurn([
      { id: 'msg-1', role: 'user', content: 'earlier failure', deliveryStatus: 'failed' },
      { id: 'msg-2', role: 'user', content: 'succeeded since', deliveryStatus: 'completed' },
      { id: 'msg-3', role: 'agent', content: 'done' },
    ]),
    null,
  )
})

test('turns that did not fail, and empty conversations, offer nothing', () => {
  assert.equal(retryableFailedTurn([]), null)
  assert.equal(retryableFailedTurn(null), null)
  assert.equal(
    retryableFailedTurn([{ id: 'msg-1', role: 'user', content: 'stopped', deliveryStatus: 'cancelled' }]),
    null,
  )
  assert.equal(
    retryableFailedTurn([{ id: 'msg-1', role: 'user', content: 'queued', deliveryStatus: 'queued' }]),
    null,
  )
  assert.equal(
    retryableFailedTurn([{ id: 'msg-1', role: 'agent', content: 'agent text', deliveryStatus: 'failed' }]),
    null,
  )
  assert.equal(
    retryableFailedTurn([{ id: 'msg-1', role: 'user', content: '   ', deliveryStatus: 'failed' }]),
    null,
  )
})

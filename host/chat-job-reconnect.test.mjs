import assert from 'node:assert/strict'
import test from 'node:test'

import { canReattachChatJob } from '../src/lib/chatJobReconnect.mjs'

test('a Host that was unreachable is reattached, because the job keeps running without the reader', () => {
  assert.equal(
    canReattachChatJob({ code: 'host_unavailable', status: 502, safeToRetry: true }),
    true,
  )
  assert.equal(
    canReattachChatJob({ code: 'host_connection_recovery_failed', status: 503, safeToRetry: true }),
    true,
  )
})

test('a truncated job stream and an untyped Host fault stay reattachable', () => {
  assert.equal(
    canReattachChatJob({ code: 'chat_job_stream_disconnected', status: 502, safeToRetry: false }),
    true,
  )
  assert.equal(canReattachChatJob({ code: null, status: 500, safeToRetry: false }), true)
})

test('a refusal that names a real fault is never reattached in a loop', () => {
  assert.equal(canReattachChatJob({ code: 'chat_job_not_found', status: 404, safeToRetry: false }), false)
  assert.equal(canReattachChatJob({ code: 'run_cancelled', status: 499, safeToRetry: false }), false)
  assert.equal(canReattachChatJob({ code: 'project_not_allowed', status: 403, safeToRetry: false }), false)
})

test('an ambiguous Host response is not reattached, so nothing is replayed blindly', () => {
  assert.equal(
    canReattachChatJob({ code: 'invalid_host_response', status: 502, safeToRetry: false }),
    false,
  )
})

test('a terminal turn outcome is reported instead of reattached, even when the turn is safe to re-send', () => {
  // The Host proves a provider quota failure touched nothing and marks it
  // safeToRetry so the *task* may be re-sent. That is not a transport fault:
  // the job already ended, so reattaching only replays the same ending forever
  // and pins the conversation to "Working".
  assert.equal(
    canReattachChatJob({ code: 'provider_quota', status: 429, safeToRetry: true, terminal: true }),
    false,
  )
  assert.equal(
    canReattachChatJob({ code: 'run_cancelled', status: 499, safeToRetry: false, terminal: true }),
    false,
  )
})

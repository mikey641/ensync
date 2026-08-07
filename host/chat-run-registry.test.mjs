import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatRunRegistry } from '../src/lib/chatRunRegistry.mjs'

test('independent conversations can run concurrently while duplicate submits stay blocked', () => {
  const runs = createChatRunRegistry()

  assert.equal(runs.begin('chat-a'), true)
  assert.equal(runs.begin('chat-a'), false)
  assert.equal(runs.begin('chat-b'), true)
  assert.deepEqual([...runs.snapshot()], ['chat-a', 'chat-b'])

  assert.equal(runs.finish('chat-a'), true)
  assert.equal(runs.has('chat-a'), false)
  assert.equal(runs.has('chat-b'), true)
  assert.deepEqual([...runs.snapshot()], ['chat-b'])

  assert.equal(runs.finish('chat-b'), true)
  assert.deepEqual([...runs.snapshot()], [])
})

test('finishing a missing run cannot clear another conversation', () => {
  const runs = createChatRunRegistry()
  runs.begin('chat-b')

  assert.equal(runs.finish('chat-a'), false)
  assert.deepEqual([...runs.snapshot()], ['chat-b'])
})

test('run registry rejects missing chat identity', () => {
  const runs = createChatRunRegistry()
  assert.throws(() => runs.begin(''), /non-empty chat ID/)
  assert.throws(() => runs.finish('   '), /non-empty chat ID/)
})

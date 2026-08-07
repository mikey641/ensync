import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executionPanelOpenForChat,
  normalizeExecutionPanelOpenByChat,
  setExecutionPanelOpenForChat,
} from '../src/lib/executionPanelPreferences.mjs'

test('the CLI execution panel is collapsed when a chat has no stored preference', () => {
  assert.equal(executionPanelOpenForChat({}, 'chat-a'), false)
})

test('an explicitly expanded panel stays expanded without changing another chat default', () => {
  const expanded = setExecutionPanelOpenForChat({}, 'chat-a', true)

  assert.equal(executionPanelOpenForChat(expanded, 'chat-a'), true)
  assert.equal(executionPanelOpenForChat(expanded, 'chat-b'), false)
  assert.equal(executionPanelOpenForChat({ ...expanded }, 'chat-a'), true)
})

test('an explicitly collapsed panel remains stored across later state copies', () => {
  const collapsed = setExecutionPanelOpenForChat({ 'chat-a': true }, 'chat-a', false)

  assert.deepEqual(collapsed, { 'chat-a': false })
  assert.equal(executionPanelOpenForChat({ ...collapsed }, 'chat-a'), false)
})

test('persisted execution-panel choices retain only chat-scoped booleans', () => {
  assert.deepEqual(normalizeExecutionPanelOpenByChat({
    'chat-a': false,
    'chat-b': true,
    'chat-invalid': 'closed',
    '': false,
  }), {
    'chat-a': false,
    'chat-b': true,
  })
  assert.deepEqual(normalizeExecutionPanelOpenByChat(null), {})
})

test('execution-panel updates reject invalid identities and values', () => {
  assert.throws(() => setExecutionPanelOpenForChat({}, '', false), /non-empty chat ID/)
  assert.throws(() => setExecutionPanelOpenForChat({}, 'chat-a', 'closed'), /boolean open state/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deliveryPanelOpenForChat,
  normalizeDeliveryPanelOpenByChat,
  setDeliveryPanelOpenForChat,
} from '../src/lib/deliveryPanelPreferences.mjs'

test('production delivery is collapsed independently for every chat by default', () => {
  assert.equal(deliveryPanelOpenForChat({}, 'chat-a'), false)
  assert.equal(deliveryPanelOpenForChat({}, 'chat-b'), false)
})

test('expanding one production-delivery panel does not expand another chat', () => {
  const expanded = setDeliveryPanelOpenForChat({}, 'chat-a', true)

  assert.equal(deliveryPanelOpenForChat(expanded, 'chat-a'), true)
  assert.equal(deliveryPanelOpenForChat(expanded, 'chat-b'), false)
})

test('persisted production-delivery choices retain only chat-scoped booleans', () => {
  assert.deepEqual(normalizeDeliveryPanelOpenByChat({
    'chat-a': false,
    'chat-b': true,
    'chat-invalid': 'closed',
    '': false,
  }), {
    'chat-a': false,
    'chat-b': true,
  })
  assert.deepEqual(normalizeDeliveryPanelOpenByChat(null), {})
})

test('production-delivery updates reject invalid identities and values', () => {
  assert.throws(() => setDeliveryPanelOpenForChat({}, '', false), /non-empty chat ID/)
  assert.throws(() => setDeliveryPanelOpenForChat({}, 'chat-a', 'closed'), /boolean open state/)
})

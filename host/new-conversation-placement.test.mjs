import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeTabIdAfterClose,
  insertNewConversationTab,
} from '../src/lib/newConversationPlacement.mjs'

const first = { id: 'tab-first', chatId: 'chat-first' }
const second = { id: 'tab-second', chatId: 'chat-second' }
const third = { id: 'tab-third', chatId: 'chat-third' }
const created = { id: 'tab-created', chatId: 'chat-created' }

test('adjacent placement uses the exact clicked tab instead of the active or final tab', () => {
  const original = [first, second, third]
  const result = insertNewConversationTab(original, created, 'adjacent', first.id)

  assert.deepEqual(result.map((tab) => tab.id), [first.id, created.id, second.id, third.id])
  assert.deepEqual(original.map((tab) => tab.id), [first.id, second.id, third.id])
})

test('end placement remains chronological regardless of which tab action was clicked', () => {
  const result = insertNewConversationTab([first, second, third], created, 'end', first.id)

  assert.deepEqual(result.map((tab) => tab.id), [first.id, second.id, third.id, created.id])
})

test('a stale adjacent anchor safely appends instead of displacing the first tab', () => {
  const result = insertNewConversationTab([first, second], created, 'adjacent', 'tab-closed')

  assert.deepEqual(result.map((tab) => tab.id), [first.id, second.id, created.id])
})

test('closing the final open tab leaves the workspace empty', () => {
  assert.equal(activeTabIdAfterClose([first], first.id, first.id), '')
})

test('closing an active tab selects its previous neighbor, or its next neighbor at the start', () => {
  assert.equal(activeTabIdAfterClose([first, second, third], second.id, second.id), first.id)
  assert.equal(activeTabIdAfterClose([first, second, third], first.id, first.id), second.id)
})

test('closing a background tab preserves the active tab', () => {
  assert.equal(activeTabIdAfterClose([first, second], first.id, second.id), first.id)
})

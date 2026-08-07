import assert from 'node:assert/strict'
import test from 'node:test'

import {
  markChatCompletionRead,
  markCompletionRead,
  unreadCompletionTabIds,
} from '../src/lib/completionReadState.mjs'

function chat(id, messages) {
  return { id, messages }
}

const tabs = [
  { id: 'tab-a', chatId: 'chat-a' },
  { id: 'tab-b', chatId: 'chat-b' },
]

test('a completed agent response remains unread until that exact response is opened', () => {
  const chats = [
    chat('chat-a', [{ id: 'agent-a-1', role: 'agent' }]),
    chat('chat-b', [{ id: 'agent-b-1', role: 'agent' }]),
  ]

  assert.deepEqual(unreadCompletionTabIds({
    tabs,
    chats,
    sendingChatIds: new Set(),
    readCompletionByChat: {},
  }), ['tab-a', 'tab-b'])

  const readCompletionByChat = markChatCompletionRead({}, chats[1])
  assert.deepEqual(readCompletionByChat, { 'chat-b': 'agent-b-1' })
  assert.deepEqual(unreadCompletionTabIds({
    tabs,
    chats,
    sendingChatIds: new Set(),
    readCompletionByChat,
  }), ['tab-a'])
})

test('a later background completion becomes unread after an earlier response was read', () => {
  const readCompletionByChat = { 'chat-a': 'agent-a-1' }
  const chats = [chat('chat-a', [
    { id: 'agent-a-1', role: 'agent' },
    { id: 'user-a-2', role: 'user', deliveryStatus: 'completed' },
    { id: 'agent-a-2', role: 'agent' },
  ])]

  assert.deepEqual(unreadCompletionTabIds({
    tabs: tabs.slice(0, 1),
    chats,
    sendingChatIds: new Set(),
    readCompletionByChat,
  }), ['tab-a'])
  assert.deepEqual(markCompletionRead(readCompletionByChat, 'chat-a', 'agent-a-2'), {
    'chat-a': 'agent-a-2',
  })
})

test('working and failed-only chats do not show completion dots', () => {
  const chats = [
    chat('chat-a', [{ id: 'agent-a-1', role: 'agent' }]),
    chat('chat-b', [{ id: 'user-b-1', role: 'user', deliveryStatus: 'failed' }]),
  ]

  assert.deepEqual(unreadCompletionTabIds({
    tabs,
    chats,
    sendingChatIds: new Set(['chat-a']),
    readCompletionByChat: {},
  }), [])
})

test('read state is chat-scoped so closing, reopening, or duplicating tab identity does not revive a dot', () => {
  const chats = [chat('chat-a', [{ id: 'agent-a-1', role: 'agent' }])]
  const readCompletionByChat = { 'chat-a': 'agent-a-1' }

  assert.deepEqual(unreadCompletionTabIds({
    tabs: [{ id: 'reopened-tab-a', chatId: 'chat-a' }],
    chats,
    sendingChatIds: [],
    readCompletionByChat,
  }), [])
})

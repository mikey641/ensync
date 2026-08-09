import assert from 'node:assert/strict'
import test from 'node:test'

import {
  conversationWorkspaceKey,
  resolveConversationWorkspaceKey,
} from '../src/lib/conversationWorkspaceKey.mjs'

test('conversation workspace keys are explicit and stable without object coercion', () => {
  assert.equal(conversationWorkspaceKey('chat-123'), 'conversation:chat-123')
  assert.equal(
    resolveConversationWorkspaceKey({ id: 'chat-123' }),
    'conversation:chat-123',
  )
  assert.throws(() => conversationWorkspaceKey('bad\nchat'), /stable Ensync conversation ID/)
})

test('successful legacy isolated chats keep their original protected worktree identity', () => {
  const legacy = {
    id: 'chat-legacy',
    workspace: {
      path: '/managed/worktree',
      branch: 'ensync/chat-legacy-hash',
    },
  }
  assert.equal(resolveConversationWorkspaceKey(legacy), '[object Object]:chat-legacy')
  assert.equal(
    resolveConversationWorkspaceKey({
      ...legacy,
      agentWorkspaceKey: 'conversation:chat-legacy',
    }),
    'conversation:chat-legacy',
  )
})

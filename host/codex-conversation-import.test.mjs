import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeImportedConversationState } from '../src/lib/nativeConversationImport.mjs'

function candidate(fingerprint, messages) {
  const chatId = 'chat-codex-import-session'
  return {
    id: fingerprint,
    project: { id: 'local-relay', name: 'relay', path: '/work/relay', host: 'local' },
    chat: {
      id: chatId,
      projectId: 'local-relay',
      title: 'Imported Codex conversation',
      subtitle: `${messages.length} visible messages`,
      group: 'Today',
      provider: 'codex',
      messages,
      importSource: {
        kind: 'codex_session', sessionId: 'session-1', projectPath: '/work/relay',
        sourceFingerprint: fingerprint, messageIds: messages.map((message) => message.id),
      },
    },
    tab: { id: 'tab-codex-import-session', chatId },
  }
}

test('conversation import adds and opens one chat without replacing existing Relay work', () => {
  const fingerprint = 'a'.repeat(64)
  const current = {
    projects: [{ id: 'existing-relay', path: '/work/relay', name: 'Relay' }],
    chats: [{ id: 'empty-chat', projectId: 'existing-relay', title: 'New conversation', messages: [] }],
    tabs: [{ id: 'empty-tab', chatId: 'empty-chat' }],
    activeTabId: 'empty-tab',
    drafts: { 'empty-chat': 'keep me' },
    splitLayout: { hiddenTabIds: ['tab-codex-import-session'], paneSizes: {}, maximizedTabId: null },
  }
  const imported = candidate(fingerprint, [
    { id: 'source-user-1', role: 'user', content: 'Visible', time: '2026-08-05T00:00:00.000Z' },
    { id: 'source-agent-1', role: 'agent', content: 'Answer', time: '2026-08-05T00:00:01.000Z' },
  ])
  const result = mergeImportedConversationState(current, imported)
  assert.deepEqual(result.summary, {
    addedChat: true, addedTab: true, addedMessages: 2,
    chatId: 'chat-codex-import-session', tabId: 'tab-codex-import-session',
  })
  assert.equal(result.state.chats.length, 2)
  assert.deepEqual(result.state.chats[0], current.chats[0])
  assert.equal(result.state.drafts['empty-chat'], 'keep me')
  assert.equal(result.state.activeProjectId, 'existing-relay')
  assert.equal(result.state.activeTabId, 'tab-codex-import-session')
  assert.deepEqual(result.state.splitLayout.hiddenTabIds, [])
  assert.equal(result.state.readCompletionByChat['chat-codex-import-session'], 'source-agent-1')
})

test('a growing source prefix adds only new message identities and repeated import is idempotent', () => {
  const first = candidate('a'.repeat(64), [
    { id: 'one', role: 'user', content: 'One', time: 'one' },
    { id: 'two', role: 'agent', content: 'Two', time: 'two' },
  ])
  const initial = mergeImportedConversationState({}, first)
  const repeated = mergeImportedConversationState(initial.state, first)
  assert.equal(repeated.state.chats.length, 1)
  assert.equal(repeated.state.tabs.length, 1)
  assert.equal(repeated.state.chats[0].messages.length, 2)
  assert.equal(repeated.summary.addedMessages, 0)

  const grown = candidate('b'.repeat(64), [...first.chat.messages, {
    id: 'three', role: 'user', content: 'Three', time: 'three',
  }])
  const updated = mergeImportedConversationState(repeated.state, grown)
  assert.equal(updated.state.chats.length, 1)
  assert.equal(updated.state.tabs.length, 1)
  assert.deepEqual(updated.state.chats[0].messages.map((message) => message.id), ['one', 'two', 'three'])
  assert.equal(updated.summary.addedMessages, 1)
  assert.deepEqual(updated.state.conversationImportIds, ['a'.repeat(64), 'b'.repeat(64)])
})

test('an unrelated deterministic ID collision is preserved and safely remapped', () => {
  const imported = candidate('c'.repeat(64), [{ id: 'source', role: 'user', content: 'Text', time: 'time' }])
  const result = mergeImportedConversationState({
    chats: [{ id: imported.chat.id, projectId: 'other', title: 'Unrelated', messages: [] }],
    tabs: [{ id: imported.tab.id, chatId: imported.chat.id }],
  }, imported)
  assert.equal(result.state.chats[0].title, 'Unrelated')
  assert.match(result.summary.chatId, /-import-cccccccccccc$/)
  assert.match(result.summary.tabId, /-import-cccccccccccc$/)
})

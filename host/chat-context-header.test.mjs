import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { storedChatContext } from '../src/lib/chatContextHeader.mjs'

const componentPath = new URL('../src/components/ChatContextHeader.tsx', import.meta.url)
const cssPath = new URL('../src/components/ChatContextHeader.css', import.meta.url)

test('sticky chat context uses stored identity and the latest non-empty user message', () => {
  const chat = {
    title: 'Add project import',
    subtitle: 'Updated just now',
    messages: [
      { id: 'first', role: 'user', content: 'Import this repository.' },
      { id: 'reply', role: 'agent', content: 'The repository is ready in the selected project.' },
      { id: 'latest-user', role: 'user', content: 'Deploy the verified branch after the tests pass.' },
      { id: 'blank-user', role: 'user', content: '  \n ' },
      { id: 'latest-reply', role: 'agent', content: 'Implemented locally, but not deployed.' },
    ],
  }

  assert.deepEqual(storedChatContext(chat), {
    title: chat.title,
    summary: chat.subtitle,
    latestUserMessage: chat.messages[2].content,
  })
})

test('sticky chat context never invents missing values', () => {
  assert.deepEqual(storedChatContext({ title: '', subtitle: '   ', messages: [] }), {
    title: null,
    summary: null,
    latestUserMessage: null,
  })
})

test('latest user message stays exact and agent-only chats never become the preview', () => {
  const exactLongMessage = `  First line\nSecond line ${'unbroken'.repeat(160)}  `
  assert.equal(storedChatContext({
    title: 'Real title',
    subtitle: 'Real summary',
    messages: [
      { role: 'user', content: exactLongMessage },
      { role: 'agent', content: 'Do not display this reply.' },
    ],
  }).latestUserMessage, exactLongMessage)

  assert.equal(storedChatContext({
    messages: [{ role: 'agent', content: 'Agent only' }],
  }).latestUserMessage, null)
})

test('latest-user popup is linked, keyboard closable, focus-restoring, and preserves exact text', async () => {
  const source = await readFile(componentPath, 'utf8')

  assert.match(source, /aria-haspopup="dialog"/)
  assert.match(source, /aria-expanded=\{latestMessageOpen\}/)
  assert.match(source, /aria-controls=\{dialogId\}/)
  assert.match(source, /<dialog[\s\S]*aria-labelledby=\{dialogTitleId\}[\s\S]*aria-describedby=\{dialogBodyId\}/)
  assert.match(source, /onCancel=\{\(event\) => \{[\s\S]*event\.preventDefault\(\)[\s\S]*closeLatestUserMessage\(\)/)
  assert.match(source, /window\.requestAnimationFrame\(\(\) => triggerRef\.current\?\.focus\(\)\)/)
  assert.match(source, /closeButtonRef\.current\?\.focus\(\)/)
  assert.ok(source.match(/\{context\.latestUserMessage\}/g)?.length >= 2)
})

test('full latest-user text wraps and scrolls within viewport bounds', async () => {
  const css = await readFile(cssPath, 'utf8')

  assert.match(css, /\.chat-context-message-dialog__panel\s*\{[\s\S]*max-height:\s*min\(78dvh, 720px\);[\s\S]*overflow:\s*hidden;/)
  assert.match(css, /\.chat-context-message-dialog__body\s*\{[\s\S]*overflow:\s*auto;[\s\S]*white-space:\s*pre-wrap;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*word-break:\s*break-word;/)
})

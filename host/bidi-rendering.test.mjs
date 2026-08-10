import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const appCssPath = new URL('../src/index.css', import.meta.url)
const messageContentPath = new URL('../src/components/MessageContent.tsx', import.meta.url)
const contextHeaderPath = new URL('../src/components/ChatContextHeader.tsx', import.meta.url)
const contextHeaderCssPath = new URL('../src/components/ChatContextHeader.css', import.meta.url)
const splitWorkspacePath = new URL('../src/components/SplitWorkspace.tsx', import.meta.url)

test('runtime conversation text uses automatic isolated direction without changing stored text', async () => {
  const [app, appCss, messageContent, contextHeader, contextHeaderCss, splitWorkspace] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(appCssPath, 'utf8'),
    readFile(messageContentPath, 'utf8'),
    readFile(contextHeaderPath, 'utf8'),
    readFile(contextHeaderCssPath, 'utf8'),
    readFile(splitWorkspacePath, 'utf8'),
  ])

  assert.equal(app.match(/<MessageContent content=\{message\.content\} \/>/g)?.length, 2)
  assert.match(messageContent, /<p dir="auto">/)
  assert.match(messageContent, /<pre dir="ltr"><code>\{code\}<\/code><\/pre>/)
  assert.match(app, /<textarea[\s\S]*?data-chat-composer=\{chat\.id\}[\s\S]*?dir="auto"/)
  assert.match(app, /<pre className="execution-panel__output"[^>]*dir="auto">/)
  assert.match(contextHeader, /chat-context-header__message-preview" dir="auto"/)
  assert.match(contextHeader, /chat-context-message-dialog__body"[\s\S]*?dir="auto"/)
  assert.equal(splitWorkspace.match(/className="relay-split-pane-title" dir="auto"/g)?.length, 2)

  assert.match(appCss, /\.message-content p\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(appCss, /\.message-content li\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(appCss, /\.message-table th, \.message-table td\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(appCss, /\.execution-panel__output\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(appCss, /\.composer textarea\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(contextHeaderCss, /\.chat-context-header__message-preview\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(contextHeaderCss, /\.chat-context-message-dialog__body\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)

  const invisibleDirectionalControls = /[\u202a-\u202e\u2066-\u2069]/u
  assert.equal(invisibleDirectionalControls.test(`${app}${contextHeader}${splitWorkspace}`), false)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const appCssPath = new URL('../src/index.css', import.meta.url)
const messageContentPath = new URL('../src/components/MessageContent.tsx', import.meta.url)
const contextHeaderPath = new URL('../src/components/ChatContextHeader.tsx', import.meta.url)
const contextHeaderCssPath = new URL('../src/components/ChatContextHeader.css', import.meta.url)
const splitWorkspacePath = new URL('../src/components/SplitWorkspace.tsx', import.meta.url)
const bidiTextPath = new URL('../src/lib/bidiText.mjs', import.meta.url)

test('runtime conversation text uses automatic isolated direction without changing stored text', async () => {
  const [app, appCss, messageContent, contextHeader, contextHeaderCss, splitWorkspace] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(appCssPath, 'utf8'),
    readFile(messageContentPath, 'utf8'),
    readFile(contextHeaderPath, 'utf8'),
    readFile(contextHeaderCssPath, 'utf8'),
    readFile(splitWorkspacePath, 'utf8'),
  ])

  assert.equal(app.match(/<MessageContent content=\{message\.content\} collapsible \/>/g)?.length, 2)
  assert.match(messageContent, /<p key=\{index\} dir="auto">\{renderDirectional\(block\.text, createBidiCursor\(\)\)\}<\/p>/)
  assert.match(messageContent, /<pre dir="ltr"><code>\{code\}<\/code><\/pre>/)
  assert.match(messageContent, /<th key=\{index\} scope="col" dir="auto"/)
  assert.match(messageContent, /<td key=\{index\} dir="auto"/)
  assert.match(messageContent, /className: 'message-heading', dir: 'auto'/)
  assert.match(messageContent, /<li dir="auto">/)
  assert.match(app, /<textarea[\s\S]*?data-chat-composer=\{chat\.id\}[\s\S]*?dir="auto"/)
  assert.match(app, /<pre className="execution-panel__output"[^>]*dir="auto">/)
  assert.match(contextHeader, /chat-context-header__message-preview" dir="auto"/)
  assert.match(contextHeader, /chat-context-message-dialog__body"[\s\S]*?dir="auto"/)
  assert.equal(splitWorkspace.match(/className="relay-split-pane-title" dir="auto"/g)?.length, 2)

  assert.match(appCss, /\.message-content p\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(appCss, /\.message-table th, \.message-table td\s*\{[^}]*text-align:\s*start;[^}]*unicode-bidi:\s*plaintext;/s)
  assert.match(appCss, /\.message-heading\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(appCss, /\.message-list li\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(appCss, /\.execution-panel__output\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(appCss, /\.composer textarea\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(contextHeaderCss, /\.chat-context-header__message-preview\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)
  assert.match(contextHeaderCss, /\.chat-context-message-dialog__body\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*start;/s)

  const invisibleDirectionalControls = /[\u202a-\u202e\u2066-\u2069]/u
  assert.equal(invisibleDirectionalControls.test(`${app}${contextHeader}${splitWorkspace}`), false)
})

test('mixed-direction phrases render inside bdi so neighbouring text keeps its place', async () => {
  const [appCss, messageContent, bidiText] = await Promise.all([
    readFile(appCssPath, 'utf8'),
    readFile(messageContentPath, 'utf8'),
    readFile(bidiTextPath, 'utf8'),
  ])

  // Both conversation renderers walk one cursor per block: the rich Markdown
  // tree and the structured blocks a long or browser-mode message uses.
  assert.match(messageContent, /<bdi key=\{key\}>\{run\.text\}<\/bdi>/)
  assert.match(messageContent, /function renderBlockInline\([\s\S]*?renderInline\(nodes, projectPath, createBidiCursor\(\)\)/)
  assert.match(messageContent, /function renderInlineText\([\s\S]*?const cursor = createBidiCursor\(\)/)
  assert.equal(/<InlineText\b/.test(messageContent), false)
  assert.match(appCss, /\.message-content bdi\s*\{[^}]*unicode-bidi:\s*isolate;/s)

  // Isolation is markup only; the rendered characters stay the stored ones.
  assert.equal(/[\u202a-\u202e\u2066-\u2069]/u.test(`${messageContent}${bidiText}`), false)
})

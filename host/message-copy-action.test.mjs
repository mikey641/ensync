import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const appCssPath = new URL('../src/index.css', import.meta.url)
const themeCssPath = new URL('../src/theme.css', import.meta.url)

test('stored user and agent messages copy their original Markdown source', async () => {
  const app = await readFile(appPath, 'utf8')
  const storedMessageActions = app.match(
    /<CopyTextButton text=\{message\.content\} label="Copy message" \/>/g,
  ) ?? []

  assert.equal(storedMessageActions.length, 2)
  assert.match(app, /navigator\.clipboard\.writeText\(text\)/)
  assert.match(app, /aria-label=\{status === 'idle' \? label : statusLabel\}/)
  assert.match(app, /className="copy-announcement" role="status" aria-live="polite"/)
})

test('message copy actions are visible for hover, keyboard, and touch input', async () => {
  const css = await readFile(appCssPath, 'utf8')

  assert.match(
    css,
    /\.message:hover \.message-actions,\s*\.message:focus-within \.message-actions\s*\{\s*opacity:\s*1;/,
  )
  assert.match(
    css,
    /@media \(hover: none\), \(pointer: coarse\)\s*\{\s*\.message-actions\s*\{\s*opacity:\s*1;/,
  )
})

test('the user copy action sits beneath the bubble without adding empty bubble space', async () => {
  const css = await readFile(themeCssPath, 'utf8')

  assert.match(css, /\.message--user\s*\{[^}]*position:\s*relative;/s)
  assert.match(
    css,
    /\.message--user \.message-actions\s*\{[^}]*position:\s*absolute;[^}]*inset-inline-end:\s*0;[^}]*inset-block-end:\s*-29px;[^}]*margin-top:\s*0;/s,
  )
})

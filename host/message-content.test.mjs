import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseInlineSegments, parseMessageContent } from '../src/lib/messageContent.mjs'

test('message content preserves alternating prose and fenced code in order', () => {
  const content = [
    'Start with this:',
    '```ts',
    'const first = true',
    '```',
    'Then explain why.',
    '```sh',
    'npm test',
    '```',
    'And finish with prose.',
  ].join('\n')

  assert.deepEqual(parseMessageContent(content), [
    { type: 'text', text: 'Start with this:\n' },
    { type: 'code', code: 'const first = true\n', language: 'ts' },
    { type: 'text', text: 'Then explain why.\n' },
    { type: 'code', code: 'npm test\n', language: 'sh' },
    { type: 'text', text: 'And finish with prose.' },
  ])
})

test('message content supports tilde fences, longer fences, and unclosed final code', () => {
  assert.deepEqual(parseMessageContent('~~~~md\n```\ninside\n```\n~~~~\nafter'), [
    { type: 'code', code: '```\ninside\n```\n', language: 'md' },
    { type: 'text', text: 'after' },
  ])
  assert.deepEqual(parseMessageContent('Before\r\n```js\r\nrun()'), [
    { type: 'text', text: 'Before\r\n' },
    { type: 'code', code: 'run()', language: 'js' },
  ])
})

test('message content leaves ordinary backticks and invalid fences as prose', () => {
  const content = 'Use `inline()` here.\n``code``\n```bad`info\nnot code'
  assert.deepEqual(parseMessageContent(content), [{ type: 'text', text: content }])
})

test('inline segments link a Markdown reference to an absolute local file', () => {
  assert.deepEqual(
    parseInlineSegments('See [design.md](</Users/me/my docs/design.md>) before editing.'),
    [
      { type: 'text', text: 'See ' },
      {
        type: 'link',
        label: 'design.md',
        kind: 'file',
        href: 'file:///Users/me/my%20docs/design.md',
        path: '/Users/me/my docs/design.md',
      },
      { type: 'text', text: ' before editing.' },
    ],
  )
})

test('inline segments link file URLs and Windows paths to their real filesystem path', () => {
  assert.deepEqual(parseInlineSegments('[spec](file:///tmp/a%20b.md)'), [{
    type: 'link',
    label: 'spec',
    kind: 'file',
    href: 'file:///tmp/a%20b.md',
    path: '/tmp/a b.md',
  }])
  assert.deepEqual(parseInlineSegments('[notes](<C:\\Users\\me\\notes.md>)'), [{
    type: 'link',
    label: 'notes',
    kind: 'file',
    href: 'file:///C:/Users/me/notes.md',
    path: 'C:\\Users\\me\\notes.md',
  }])
})

test('inline segments link https targets and keep unsupported targets as prose', () => {
  assert.deepEqual(parseInlineSegments('[Docs](https://ensync.app/docs) then [bad](javascript:alert)'), [
    { type: 'link', label: 'Docs', kind: 'external', href: 'https://ensync.app/docs' },
    { type: 'text', text: ' then [bad](javascript:alert)' },
  ])
})

test('inline segments autolink bare https URLs without swallowing trailing punctuation', () => {
  assert.deepEqual(parseInlineSegments('Open https://ensync.app/docs. Done'), [
    { type: 'text', text: 'Open ' },
    { type: 'link', label: 'https://ensync.app/docs', kind: 'external', href: 'https://ensync.app/docs' },
    { type: 'text', text: '. Done' },
  ])
  assert.deepEqual(parseInlineSegments('<https://ensync.app/a_(b)>'), [{
    type: 'link',
    label: 'https://ensync.app/a_(b)',
    kind: 'external',
    href: 'https://ensync.app/a_(b)',
  }])
})

test('inline segments keep link-free prose as one exact text segment', () => {
  const text = 'No links here [not a link] (either) — just prose.\nSecond line.'
  assert.deepEqual(parseInlineSegments(text), [{ type: 'text', text }])
  assert.deepEqual(parseInlineSegments(''), [])
})

test('message rendering turns inline segments into anchors and opens local files natively', async () => {
  const source = await readFile(new URL('../src/components/MessageContent.tsx', import.meta.url), 'utf8')

  assert.match(source, /parseInlineSegments/)
  assert.match(source, /segment\.kind === 'file'/)
  assert.match(source, /window\.ensyncDesktop\?\.openLocalFile/)
  assert.match(source, /target="_blank" rel="noreferrer"/)
})

test('a file link opens the in-app file display before any system opener', async () => {
  const [messageContent, app] = await Promise.all([
    readFile(new URL('../src/components/MessageContent.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(messageContent, /onOpenFile\?: \(path: string\) => void/)
  assert.match(messageContent, /if \(onOpenFile\) \{[\s\S]*?onOpenFile\(segment\.path\)[\s\S]*?return/)
  assert.match(app, /<FileViewerModal path=\{viewedFilePath\} onClose=\{\(\) => setViewedFilePath\(null\)\} \/>/)
  assert.match(app, /onOpenFile=\{setViewedFilePath\}/)
  assert.equal(app.match(/<MessageContent content=\{[^}]+\} onOpenFile=\{onOpenFile\} \/>/g)?.length, 3)
})

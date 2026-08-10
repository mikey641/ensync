import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isLongMessageContent, parseMessageContent } from '../src/lib/messageContent.mjs'

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
    { type: 'paragraph', text: 'Start with this:' },
    { type: 'code', code: 'const first = true\n', language: 'ts' },
    { type: 'paragraph', text: 'Then explain why.' },
    { type: 'code', code: 'npm test\n', language: 'sh' },
    { type: 'paragraph', text: 'And finish with prose.' },
  ])
})

test('message content supports tilde fences, longer fences, and unclosed final code', () => {
  assert.deepEqual(parseMessageContent('~~~~md\n```\ninside\n```\n~~~~\nafter'), [
    { type: 'code', code: '```\ninside\n```\n', language: 'md' },
    { type: 'paragraph', text: 'after' },
  ])
  assert.deepEqual(parseMessageContent('Before\r\n```js\r\nrun()'), [
    { type: 'paragraph', text: 'Before' },
    { type: 'code', code: 'run()', language: 'js' },
  ])
})

test('message content parses headings, rules, and quotes', () => {
  assert.deepEqual(parseMessageContent('## What it is ##\ntext\n\n---\n\n> quoted\n> lines'), [
    { type: 'heading', level: 2, text: 'What it is' },
    { type: 'paragraph', text: 'text' },
    { type: 'rule' },
    { type: 'quote', blocks: [{ type: 'paragraph', text: 'quoted\nlines' }] },
  ])
  assert.deepEqual(parseMessageContent('#hashtag is not a heading'), [
    { type: 'paragraph', text: '#hashtag is not a heading' },
  ])
})

test('message content parses bullet and ordered lists including nesting', () => {
  assert.deepEqual(parseMessageContent('- one\n- two\n  - nested\n'), [{
    type: 'list',
    ordered: false,
    start: null,
    items: [
      [{ type: 'paragraph', text: 'one' }],
      [
        { type: 'paragraph', text: 'two' },
        { type: 'list', ordered: false, start: null, items: [[{ type: 'paragraph', text: 'nested' }]] },
      ],
    ],
  }])
  assert.deepEqual(parseMessageContent('2. first\n3. second'), [{
    type: 'list',
    ordered: true,
    start: 2,
    items: [
      [{ type: 'paragraph', text: 'first' }],
      [{ type: 'paragraph', text: 'second' }],
    ],
  }])
})

test('message content keeps thematic breaks from being read as bullets', () => {
  assert.deepEqual(parseMessageContent('***'), [{ type: 'rule' }])
  assert.deepEqual(parseMessageContent('- - -'), [{ type: 'rule' }])
})

test('message content parses GitHub tables with alignment, escapes, and ragged rows', () => {
  const content = [
    'Here are the jobs:',
    '',
    '| Job | Schedule | Does |',
    '|---|:-:|---:|',
    '| `com.mikey.ha-uptime` | every 60s | curl probe of HA local + funnel |',
    '| escaped \\| pipe | | only two |',
    '| extra | cells | are | ignored |',
    '',
    'Done.',
  ].join('\n')

  assert.deepEqual(parseMessageContent(content), [
    { type: 'paragraph', text: 'Here are the jobs:' },
    {
      type: 'table',
      header: ['Job', 'Schedule', 'Does'],
      alignments: [null, 'center', 'right'],
      rows: [
        ['`com.mikey.ha-uptime`', 'every 60s', 'curl probe of HA local + funnel'],
        ['escaped | pipe', '', 'only two'],
        ['extra', 'cells', 'are'],
      ],
    },
    { type: 'paragraph', text: 'Done.' },
  ])
})

test('message content parses tables without edge pipes and pads missing cells', () => {
  assert.deepEqual(parseMessageContent('Job | Does\n:--- | ---\nx | y'), [{
    type: 'table',
    header: ['Job', 'Does'],
    alignments: ['left', null],
    rows: [['x', 'y']],
  }])
  assert.deepEqual(parseMessageContent('Job | Does\n--- | ---\nx |'), [{
    type: 'table',
    header: ['Job', 'Does'],
    alignments: [null, null],
    rows: [['x', '']],
  }])
})

test('message content ends a table at the first blank or pipe-less line', () => {
  assert.deepEqual(parseMessageContent('| a | b |\n| --- | --- |\n| c | d |\nnot a row'), [
    { type: 'table', header: ['a', 'b'], alignments: [null, null], rows: [['c', 'd']] },
    { type: 'paragraph', text: 'not a row' },
  ])
})

test('message content keeps pipe prose and fenced tables uninterpreted', () => {
  assert.deepEqual(parseMessageContent('a | b\nc | d'), [{ type: 'paragraph', text: 'a | b\nc | d' }])
  assert.deepEqual(parseMessageContent('| a | b |\n| --- |\n| c | d |'), [
    { type: 'paragraph', text: '| a | b |\n| --- |\n| c | d |' },
  ])
  assert.deepEqual(parseMessageContent('```md\n| a |\n| --- |\n| b |\n```'), [
    { type: 'code', code: '| a |\n| --- |\n| b |\n', language: 'md' },
  ])
})

test('inline parsing resolves code, emphasis, and strikethrough', () => {
  assert.deepEqual(parseInline('run `npm test` now'), [
    { type: 'text', text: 'run ' },
    { type: 'code', text: 'npm test' },
    { type: 'text', text: ' now' },
  ])
  assert.deepEqual(parseInline('**bold** and *thin* and ~~gone~~'), [
    { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
    { type: 'text', text: ' and ' },
    { type: 'em', children: [{ type: 'text', text: 'thin' }] },
    { type: 'text', text: ' and ' },
    { type: 'strike', children: [{ type: 'text', text: 'gone' }] },
  ])
  assert.deepEqual(parseInline('**outer `code` end**'), [{
    type: 'strong',
    children: [
      { type: 'text', text: 'outer ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ' end' },
    ],
  }])
})

test('inline parsing leaves identifiers and unmatched delimiters literal', () => {
  assert.deepEqual(parseInline('snake_case_name stays'), [{ type: 'text', text: 'snake_case_name stays' }])
  assert.deepEqual(parseInline('unclosed ` backtick'), [{ type: 'text', text: 'unclosed ` backtick' }])
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ type: 'text', text: '2 * 3 * 4' }])
  assert.deepEqual(parseInline('escaped \\*not emphasis\\*'), [{ type: 'text', text: 'escaped *not emphasis*' }])
})

test('inline parsing links only safe destinations', () => {
  assert.deepEqual(parseInline('see [docs](https://example.com/a)'), [
    { type: 'text', text: 'see ' },
    { type: 'link', href: 'https://example.com/a', children: [{ type: 'text', text: 'docs' }] },
  ])
  assert.deepEqual(parseInline('bare https://example.com/x works'), [
    { type: 'text', text: 'bare ' },
    { type: 'link', href: 'https://example.com/x', children: [{ type: 'text', text: 'https://example.com/x' }] },
    { type: 'text', text: ' works' },
  ])
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [
    { type: 'text', text: '[x](javascript:alert(1))' },
  ])
})

test('message content renders the reported broken message as structured blocks', () => {
  const content = [
    '## What Superpowers is',
    '',
    'Superpowers is a **prompt-level behavior layer for one agent inside one session**.',
    '',
    '- `repository.head` is `git rev-parse HEAD` in the local checkout.',
    '- Nothing ever integrates back.',
  ].join('\n')

  const blocks = parseMessageContent(content)
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'list'])
  assert.equal(blocks[0].level, 2)
  assert.equal(blocks[0].text, 'What Superpowers is')
  assert.equal(blocks[2].items.length, 2)
  assert.deepEqual(parseInline(blocks[1].text).map(node => node.type), ['text', 'strong', 'text'])
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

test('message content becomes collapsible only after a meaningful length or line threshold', () => {
  assert.equal(isLongMessageContent('A concise message.\nWith a second line.'), false)
  assert.equal(isLongMessageContent('x'.repeat(900)), false)
  assert.equal(isLongMessageContent('x'.repeat(901)), true)
  assert.equal(isLongMessageContent('🙂'.repeat(900)), false)
  assert.equal(isLongMessageContent('🙂'.repeat(901)), true)
  assert.equal(isLongMessageContent(Array.from({ length: 14 }, (_, index) => `line ${index}`).join('\n')), false)
  assert.equal(isLongMessageContent(Array.from({ length: 15 }, (_, index) => `line ${index}`).join('\n')), true)
})

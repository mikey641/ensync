import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInline, parseMessageContent } from '../src/lib/messageContent.mjs'

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

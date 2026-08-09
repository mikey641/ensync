import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInline, parseMarkdown, safeMarkdownHref } from '../src/lib/markdown.mjs'

const text = (value) => ({ type: 'text', text: value })

test('inline parsing covers emphasis, code, strike, and links', () => {
  assert.deepEqual(parseInline('plain'), [text('plain')])
  assert.deepEqual(parseInline('a **bold** b'), [
    text('a '),
    { type: 'strong', inline: [text('bold')] },
    text(' b'),
  ])
  assert.deepEqual(parseInline('a *thin* b'), [
    text('a '),
    { type: 'emphasis', inline: [text('thin')] },
    text(' b'),
  ])
  assert.deepEqual(parseInline('use `npm test` now'), [
    text('use '),
    { type: 'code', text: 'npm test' },
    text(' now'),
  ])
  assert.deepEqual(parseInline('~~old~~'), [{ type: 'strike', inline: [text('old')] }])
  assert.deepEqual(parseInline('see [docs](https://x.dev/a)'), [
    text('see '),
    { type: 'link', href: 'https://x.dev/a', inline: [text('docs')] },
  ])
})

test('inline parsing leaves snake_case and escapes alone', () => {
  assert.deepEqual(parseInline('call some_long_name here'), [text('call some_long_name here')])
  assert.deepEqual(parseInline('literal \\*stars\\*'), [text('literal *stars*')])
  assert.deepEqual(parseInline('`a * b` stays'), [
    { type: 'code', text: 'a * b' },
    text(' stays'),
  ])
})

test('inline code wins over emphasis and nesting composes', () => {
  assert.deepEqual(parseInline('**bold `code` in**'), [
    {
      type: 'strong',
      inline: [text('bold '), { type: 'code', text: 'code' }, text(' in')],
    },
  ])
})

test('headings, rules, and paragraphs parse as blocks', () => {
  assert.deepEqual(parseMarkdown('# Title\n\nBody text.'), [
    { type: 'heading', level: 1, inline: [text('Title')] },
    { type: 'paragraph', inline: [text('Body text.')] },
  ])
  assert.deepEqual(parseMarkdown('### Deep'), [
    { type: 'heading', level: 3, inline: [text('Deep')] },
  ])
  assert.deepEqual(parseMarkdown('a\n\n---\n\nb'), [
    { type: 'paragraph', inline: [text('a')] },
    { type: 'rule' },
    { type: 'paragraph', inline: [text('b')] },
  ])
})

test('a hash without a space is not a heading', () => {
  assert.deepEqual(parseMarkdown('#nothashtag'), [
    { type: 'paragraph', inline: [text('#nothashtag')] },
  ])
})

test('GFM tables parse with alignment, header, and rows', () => {
  const source = [
    '| Name | Count | Note |',
    '| :--- | ----: | :--: |',
    '| a    | 1     | ok   |',
    '| b    | 2     | no   |',
  ].join('\n')

  assert.deepEqual(parseMarkdown(source), [
    {
      type: 'table',
      align: ['left', 'right', 'center'],
      header: [[text('Name')], [text('Count')], [text('Note')]],
      rows: [
        [[text('a')], [text('1')], [text('ok')]],
        [[text('b')], [text('2')], [text('no')]],
      ],
    },
  ])
})

test('tables keep inline formatting and honour escaped pipes', () => {
  const source = [
    'Col | Value',
    '--- | ---',
    '`x` | **y**',
    'a \\| b | c',
  ].join('\n')

  assert.deepEqual(parseMarkdown(source), [
    {
      type: 'table',
      align: [null, null],
      header: [[text('Col')], [text('Value')]],
      rows: [
        [[{ type: 'code', text: 'x' }], [{ type: 'strong', inline: [text('y')] }]],
        [[text('a | b')], [text('c')]],
      ],
    },
  ])
})

test('a pipe line without a delimiter row stays prose', () => {
  assert.deepEqual(parseMarkdown('a | b\nc | d'), [
    { type: 'paragraph', inline: [text('a | b\nc | d')] },
  ])
})

test('lists parse ordered and unordered items', () => {
  assert.deepEqual(parseMarkdown('- one\n- two'), [
    {
      type: 'list',
      ordered: false,
      start: 1,
      items: [
        [{ type: 'paragraph', inline: [text('one')] }],
        [{ type: 'paragraph', inline: [text('two')] }],
      ],
    },
  ])
  assert.deepEqual(parseMarkdown('3. three\n4. four'), [
    {
      type: 'list',
      ordered: true,
      start: 3,
      items: [
        [{ type: 'paragraph', inline: [text('three')] }],
        [{ type: 'paragraph', inline: [text('four')] }],
      ],
    },
  ])
})

test('nested lists parse recursively', () => {
  assert.deepEqual(parseMarkdown('- top\n  - inner'), [
    {
      type: 'list',
      ordered: false,
      start: 1,
      items: [
        [
          { type: 'paragraph', inline: [text('top')] },
          {
            type: 'list',
            ordered: false,
            start: 1,
            items: [[{ type: 'paragraph', inline: [text('inner')] }]],
          },
        ],
      ],
    },
  ])
})

test('blockquotes parse their contents recursively', () => {
  assert.deepEqual(parseMarkdown('> quoted **bold**'), [
    {
      type: 'quote',
      blocks: [
        {
          type: 'paragraph',
          inline: [text('quoted '), { type: 'strong', inline: [text('bold')] }],
        },
      ],
    },
  ])
})

test('paragraphs keep their internal newlines and split on blank lines', () => {
  assert.deepEqual(parseMarkdown('one\ntwo\n\nthree'), [
    { type: 'paragraph', inline: [text('one\ntwo')] },
    { type: 'paragraph', inline: [text('three')] },
  ])
})

test('only navigable link schemes survive sanitising', () => {
  assert.equal(safeMarkdownHref('https://x.dev/a'), 'https://x.dev/a')
  assert.equal(safeMarkdownHref('HTTP://x.dev'), 'HTTP://x.dev')
  assert.equal(safeMarkdownHref('mailto:a@b.dev'), 'mailto:a@b.dev')
  assert.equal(safeMarkdownHref('./relative/path'), './relative/path')
  assert.equal(safeMarkdownHref('#anchor'), '#anchor')

  assert.equal(safeMarkdownHref('javascript:alert(1)'), null)
  assert.equal(safeMarkdownHref('JavaScript:alert(1)'), null)
  assert.equal(safeMarkdownHref('java\nscript:alert(1)'), null)
  assert.equal(safeMarkdownHref(' javascript:alert(1)'), null)
  assert.equal(safeMarkdownHref('data:text/html,<script>'), null)
  assert.equal(safeMarkdownHref('//evil.dev'), null)
  assert.equal(safeMarkdownHref(''), null)
  assert.equal(safeMarkdownHref(null), null)
})

test('empty and blank input yields no blocks', () => {
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('   \n\n'), [])
  assert.deepEqual(parseMarkdown(null), [])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMessageContent } from '../src/lib/messageContent.mjs'

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

test('message content extracts local Markdown images without interpreting fenced code', () => {
  const logoPath = '/Users/example/Ensync workspace/brand/ensync-logo.png'
  const content = [
    'Here is the full logo:',
    '',
    `![Ensync logo](<${logoPath}>)`,
    '',
    '```md',
    '![This remains code](./not-rendered.png)',
    '```',
    '',
    'And the icon: ![App icon](brand/icon.png "Generated icon")',
  ].join('\n')

  assert.deepEqual(parseMessageContent(content), [
    { type: 'text', text: 'Here is the full logo:\n\n' },
    {
      type: 'image',
      alt: 'Ensync logo',
      path: logoPath,
      markdown: `![Ensync logo](<${logoPath}>)`,
    },
    { type: 'text', text: '\n\n' },
    { type: 'code', code: '![This remains code](./not-rendered.png)\n', language: 'md' },
    { type: 'text', text: '\nAnd the icon: ' },
    {
      type: 'image',
      alt: 'App icon',
      path: 'brand/icon.png',
      markdown: '![App icon](brand/icon.png "Generated icon")',
    },
  ])
})

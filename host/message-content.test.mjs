import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMessageContent, parseMessageText } from '../src/lib/messageContent.mjs'

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

test('message prose exposes Markdown, angle, and bare HTTPS links', () => {
  const content = 'Read [the guide](https://example.com/guide), <https://example.com/api>, or https://example.com/a_(b).'

  assert.deepEqual(parseMessageText(content), [
    { type: 'text', text: 'Read ' },
    { type: 'link', text: 'the guide', href: 'https://example.com/guide' },
    { type: 'text', text: ', ' },
    { type: 'link', text: 'https://example.com/api', href: 'https://example.com/api' },
    { type: 'text', text: ', or ' },
    { type: 'link', text: 'https://example.com/a_(b)', href: 'https://example.com/a_(b)' },
    { type: 'text', text: '.' },
  ])
})

test('message prose keeps code, images, and unsupported link schemes inert', () => {
  const content = [
    '`https://example.com/in-code`',
    '![preview](https://example.com/image.png)',
    '[unsafe](javascript:alert(1))',
    'http://example.com',
  ].join(' ')

  assert.deepEqual(parseMessageText(content), [{ type: 'text', text: content }])
})

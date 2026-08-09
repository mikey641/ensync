import assert from 'node:assert/strict'
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

test('message content becomes collapsible only after a meaningful length or line threshold', () => {
  assert.equal(isLongMessageContent('A concise message.\nWith a second line.'), false)
  assert.equal(isLongMessageContent('x'.repeat(900)), false)
  assert.equal(isLongMessageContent('x'.repeat(901)), true)
  assert.equal(isLongMessageContent('🙂'.repeat(900)), false)
  assert.equal(isLongMessageContent('🙂'.repeat(901)), true)
  assert.equal(isLongMessageContent(Array.from({ length: 14 }, (_, index) => `line ${index}`).join('\n')), false)
  assert.equal(isLongMessageContent(Array.from({ length: 15 }, (_, index) => `line ${index}`).join('\n')), true)
})

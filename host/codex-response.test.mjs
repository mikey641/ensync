import assert from 'node:assert/strict'
import test from 'node:test'
import { finalCodexResponse } from './codex-response.mjs'

test('Codex response joins ordered final-answer items and excludes commentary', () => {
  assert.equal(finalCodexResponse([
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Inspecting the app.' },
    { id: 'code', type: 'agentMessage', phase: 'final_answer', text: '```ts\nconst ready = true\n```' },
    { id: 'text', type: 'agentMessage', phase: 'final_answer', text: 'That keeps the state ordered.' },
    { id: 'more-code', type: 'agentMessage', phase: 'final_answer', text: '```ts\nstart()\n```' },
  ]), '```ts\nconst ready = true\n```\n\nThat keeps the state ordered.\n\n```ts\nstart()\n```')
})

test('Codex response keeps the last unphased legacy message', () => {
  assert.equal(finalCodexResponse([
    { type: 'agent_message', text: 'Older progress' },
    { type: 'agent_message', text: 'Older final response' },
  ]), 'Older final response')
})

test('Codex response deduplicates repeated item IDs and never substitutes commentary', () => {
  assert.equal(finalCodexResponse([
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Old text' },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Updated text' },
  ]), 'Updated text')
  assert.equal(finalCodexResponse([
    { type: 'agentMessage', phase: 'commentary', text: 'Still working' },
  ]), null)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TRANSCRIPT_PROVIDER_NOTE_LIMIT,
  transcriptProviderNotes,
} from '../src/lib/liveProviderNotes.mjs'

const note = (sequence, text) => ({ type: 'note', at: `t${sequence}`, sequence, provider: 'codex', text })

test('an active run shows only note events and keeps the six-note cap', () => {
  const events = [
    { type: 'started', at: 't0', command: 'codex exec', cwd: '/tmp/project' },
    ...Array.from({ length: 9 }, (_, index) => note(index + 1, `progress ${index + 1}`)),
    { type: 'output', at: 't10', stream: 'stdout', text: 'raw CLI line' },
  ]

  const visible = transcriptProviderNotes(events, true)

  assert.equal(visible.length, TRANSCRIPT_PROVIDER_NOTE_LIMIT)
  assert.ok(visible.every((event) => event.type === 'note'))
  assert.deepEqual(visible.map((event) => event.text), [
    'progress 4', 'progress 5', 'progress 6', 'progress 7', 'progress 8', 'progress 9',
  ])
})

test('a completed run renders no transcript notes even when note events persist', () => {
  const events = [note(1, 'planning'), note(2, 'editing files'), { type: 'result', at: 't3', outcome: 'success' }]

  assert.deepEqual(transcriptProviderNotes(events, false), [])
})

test('deriving transcript notes never mutates the execution events used by the CLI panel', () => {
  const events = [note(1, 'planning'), { type: 'output', at: 't2', stream: 'stdout', text: 'line' }, note(3, 'reviewing')]
  const snapshot = structuredClone(events)

  transcriptProviderNotes(events, true)
  transcriptProviderNotes(events, false)

  assert.deepEqual(events, snapshot)
})

test('missing or malformed event collections yield an empty transcript list', () => {
  assert.deepEqual(transcriptProviderNotes(undefined, true), [])
  assert.deepEqual(transcriptProviderNotes(null, false), [])
})

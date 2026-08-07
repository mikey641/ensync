import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nextWorkingElapsedDelay,
  workingElapsedLabel,
  workingElapsedSeconds,
} from '../src/lib/workingElapsed.mjs'

const STARTED_AT = '2026-08-06T12:00:00.000Z'
const STARTED_AT_MS = Date.parse(STARTED_AT)

test('working elapsed label is derived from the real run timestamp', () => {
  assert.equal(workingElapsedSeconds(STARTED_AT, STARTED_AT_MS), 0)
  assert.equal(workingElapsedSeconds(STARTED_AT, STARTED_AT_MS + 27_999), 27)
  assert.equal(workingElapsedLabel({ running: true, startedAt: STARTED_AT, nowMs: STARTED_AT_MS + 27_999 }), '• Working (27s)')
})

test('working elapsed label shows minutes and remaining seconds for longer runs', () => {
  assert.equal(workingElapsedLabel({ running: true, startedAt: STARTED_AT, nowMs: STARTED_AT_MS + 60_000 }), '• Working (1m 0s)')
  assert.equal(workingElapsedLabel({ running: true, startedAt: STARTED_AT, nowMs: STARTED_AT_MS + 983_000 }), '• Working (16m 23s)')
})

test('independent run timestamps produce independent pane labels', () => {
  const nowMs = STARTED_AT_MS + 40_000
  assert.equal(workingElapsedLabel({ running: true, startedAt: STARTED_AT, nowMs }), '• Working (40s)')
  assert.equal(workingElapsedLabel({ running: true, startedAt: '2026-08-06T12:00:31.000Z', nowMs }), '• Working (9s)')
})

test('terminal and restored interrupted states never retain a working timer', () => {
  assert.equal(workingElapsedLabel({ running: false, startedAt: STARTED_AT, nowMs: STARTED_AT_MS + 27_000 }), null)
  assert.equal(workingElapsedLabel({ running: true, startedAt: null, nowMs: STARTED_AT_MS + 27_000 }), null)
  assert.equal(workingElapsedLabel({ running: true, startedAt: 'not-a-date', nowMs: STARTED_AT_MS + 27_000 }), null)
})

test('refresh delay aligns updates to the next elapsed-second boundary', () => {
  assert.equal(nextWorkingElapsedDelay(STARTED_AT, STARTED_AT_MS), 1_000)
  assert.equal(nextWorkingElapsedDelay(STARTED_AT, STARTED_AT_MS + 27_250), 750)
  assert.equal(nextWorkingElapsedDelay('not-a-date', STARTED_AT_MS), 1_000)
})

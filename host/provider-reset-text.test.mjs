import assert from 'node:assert/strict'
import test from 'node:test'
import { providerResetText } from '../src/lib/providerResetText.mjs'

test('absolute Codex reset schedules match the Claude reset-label structure', () => {
  assert.equal(providerResetText({
    resetsIn: '2026-08-13T13:17:40.000Z',
    resetWindow: 'Weekly',
  }, 'Asia/Jerusalem'), 'Weekly resets Aug 13 at 4:17pm (Asia/Jerusalem)')
})

test('provider-authored reset labels retain the matching window prefix', () => {
  assert.equal(providerResetText({
    resetLabel: 'Aug 9 at 12:59am (Asia/Jerusalem)',
    resetWindow: 'Week (all models)',
  }), 'Week (all models) resets Aug 9 at 12:59am (Asia/Jerusalem)')
})

test('invalid or missing reset schedules stay blank', () => {
  assert.equal(providerResetText({ resetsIn: 'not-a-date' }, 'Asia/Jerusalem'), null)
  assert.equal(providerResetText({}), null)
})

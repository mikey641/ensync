import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAmpAccount } from './amp-usage.mjs'

const CHECKED_AT = '2026-09-07T00:00:00.000Z'

test('parseAmpAccount reads the signed-in account and balance from amp usage', () => {
  const account = parseAmpAccount({
    exitCode: 0,
    stderr: '',
    timedOut: false,
    error: null,
    stdout: 'Signed in as mikey641@gmail.com\nIndividual credits: $0 remaining - https://ampcode.com/settings',
  }, CHECKED_AT)

  assert.equal(account.authentication.state, 'authenticated')
  assert.equal(account.authentication.accountLogin, 'mikey641@gmail.com')
  assert.equal(account.authentication.exactPlan, null)
  assert.equal(account.usage.source, 'cli')
  assert.equal(account.usage.usedPercent, null)
  assert.equal(account.usage.remainingPercent, null)
  assert.deepEqual(account.usage.details, [{ label: 'Individual credits', value: '$0 remaining' }])
})

test('parseAmpAccount keeps the balance details when no denominator exists', () => {
  const account = parseAmpAccount({
    exitCode: 0,
    stderr: '',
    timedOut: false,
    error: null,
    stdout: 'Signed in as someone@example.com\nIndividual credits: $12 remaining',
  }, CHECKED_AT)

  assert.equal(account.authentication.state, 'authenticated')
  assert.equal(account.authentication.accountLogin, 'someone@example.com')
  assert.equal(account.usage.details[0].value, '$12 remaining')
})

test('parseAmpAccount degrades to unavailable without a signed-in line', () => {
  const account = parseAmpAccount({
    exitCode: 0,
    stderr: '',
    timedOut: false,
    error: null,
    stdout: 'Individual credits: $0 remaining',
  }, CHECKED_AT)

  assert.equal(account.authentication.state, 'unavailable')
  assert.equal(account.authentication.accountLogin, null)
  assert.equal(account.usage, null)
})

test('parseAmpAccount degrades on timeout or startup failure', () => {
  for (const result of [
    { exitCode: 0, stderr: '', timedOut: true, error: null, stdout: '' },
    { exitCode: 0, stderr: '', timedOut: false, error: 'spawn failed', stdout: '' },
  ]) {
    const account = parseAmpAccount(result, CHECKED_AT)
    assert.equal(account.authentication.state, 'unavailable')
    assert.equal(account.usage, null)
  }
})

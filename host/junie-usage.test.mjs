import assert from 'node:assert/strict'
import test from 'node:test'
import { parseJunieUsage } from './junie-usage.mjs'

const CHECKED_AT = '2026-09-07T14:00:00.000Z'

function fixture({ license = 'JetBrains AI Pro', balance = '12.50 credits' } = {}) {
  const header = 'Current session   All-time   License & quota'.padEnd(400, ' ')
  const licenseLine = `License: ${license}`
  const balanceLine = `Balance left: ${balance}`
  const row = `${' '.repeat(140)}${licenseLine}${' '.repeat(200 - licenseLine.length)}${balanceLine}${' '.repeat(120)}Top up at https://jb.gg/junie_top_up`
  return `${'v'.repeat(800)}${header}${' '.repeat(2000)}${row}${' '.repeat(2000)}`
}

test('parseJunieUsage reports the license and raw credit balance as quota details', () => {
  const usage = parseJunieUsage({ stdout: fixture(), exitCode: 0 }, CHECKED_AT)

  assert.equal(usage.kind, 'subscription_quota')
  assert.equal(usage.source, 'cli')
  assert.equal(usage.availability, 'unavailable')
  assert.equal(usage.usedPercent, null)
  assert.equal(usage.remainingPercent, null)
  assert.equal(usage.resetAt, null)
  assert.deepEqual(usage.details, [
    { label: 'License', value: 'JetBrains AI Pro' },
    { label: 'Balance left', value: '12.50 credits' },
  ])
})

test('parseJunieUsage accepts an explicit no-active-license account', () => {
  const usage = parseJunieUsage({ stdout: fixture({ license: 'No active license found', balance: '0.00 credits' }), exitCode: 0 }, CHECKED_AT)

  assert.deepEqual(usage.details, [
    { label: 'License', value: 'No active license found' },
    { label: 'Balance left', value: '0.00 credits' },
  ])
})

test('parseJunieUsage defaults a unitless balance to credits', () => {
  const usage = parseJunieUsage({ stdout: fixture({ balance: '7' }), exitCode: 0 }, CHECKED_AT)
  assert.deepEqual(usage.details[1], { label: 'Balance left', value: '7 credits' })
})

test('parseJunieUsage refuses captures without the stats panel or a balance', () => {
  const missingHeader = fixture().replace('Current session', '')
  assert.equal(parseJunieUsage({ stdout: missingHeader, exitCode: 0 }, CHECKED_AT), null)

  const noBalance = fixture().replace('Balance left:', '')
  assert.equal(parseJunieUsage({ stdout: noBalance, exitCode: 0 }, CHECKED_AT), null)

  assert.equal(parseJunieUsage({ stdout: '', exitCode: 0 }, CHECKED_AT), null)
  assert.equal(parseJunieUsage({ timedOut: true, stdout: fixture() }, CHECKED_AT), null)
  assert.equal(parseJunieUsage({ error: 'spawn failed', stdout: fixture() }, CHECKED_AT), null)
  assert.equal(parseJunieUsage(null, CHECKED_AT), null)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAntigravityStatus } from './antigravity-usage.mjs'

const CHECKED_AT = '2026-09-07T14:00:00.000Z'

const PANEL = [
  '└ Models & Quota',
  '',
  '',
  '  Account: mikey641@gmail.com',
  '',
  'GEMINI MODELS',
  '',
  '  Models within this group: Gemini Flash, Gemini Pro',
  '',
  '',
  '  Weekly Limit Remaining',
  '',
  '    [██████████████████████████████████████████████████] 99.81%',
  '',
  '    100% remaining · Refreshes in 156h 53m',
  '',
  '',
  '',
  'CLAUDE AND GPT MODELS',
  '',
  '  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
  '',
  '',
  '  Weekly Limit Remaining',
  '',
  '    [██████████████████████████████████████████████████] 100.00%',
  '',
  '    Quota available',
  '',
].join('\n')

function result(fixture = PANEL) {
  return { stdout: fixture, exitCode: 0 }
}

test('parseAntigravityStatus reads the account and the most-used weekly model group', () => {
  const { authentication, usage } = parseAntigravityStatus(result(), CHECKED_AT)

  assert.equal(authentication.state, 'authenticated')
  assert.equal(authentication.accountLogin, 'mikey641@gmail.com')
  assert.equal(authentication.exactPlan, null)

  assert.equal(usage.kind, 'subscription_quota')
  assert.equal(usage.source, 'cli')
  assert.equal(usage.usedPercent, 0.19)
  assert.equal(usage.remainingPercent, 99.81)
  assert.equal(usage.resetLabel, '156h 53m')
  assert.equal(usage.resetWindow, 'Weekly')
  assert.deepEqual(usage.details, [
    { label: 'Gemini models', value: '99.81% remaining · refreshes in 156h 53m' },
    { label: 'Claude & GPT models', value: '100% remaining · quota available' },
  ])
})

test('parseAntigravityStatus reports a fully consumed group and omits a quota-available reset', () => {
  const fixture = PANEL.replace('99.81%', '0.00%')
    .replace('100% remaining · Refreshes in 156h 53m', '0% remaining · Refreshes in 1h 2m')

  const { usage } = parseAntigravityStatus(result(fixture), CHECKED_AT)

  assert.equal(usage.usedPercent, 100)
  assert.equal(usage.remainingPercent, 0)
  assert.equal(usage.resetLabel, '1h 2m')
  assert.equal(usage.details[0].value, '0% remaining · refreshes in 1h 2m')
})

test('parseAntigravityStatus refuses a capture without an account or a quota group', () => {
  const noAccount = PANEL.replace('Account: mikey641@gmail.com', '')
  const parsed = parseAntigravityStatus(result(noAccount), CHECKED_AT)
  assert.equal(parsed.authentication.state, 'unavailable')
  assert.equal(parsed.usage, null)

  const noGroups = PANEL.replace(/Weekly Limit Remaining/g, '')
  const groupless = parseAntigravityStatus(result(noGroups), CHECKED_AT)
  assert.equal(groupless.authentication.state, 'authenticated')
  assert.equal(groupless.usage, null)

  const notPanel = parseAntigravityStatus({ stdout: 'Welcome to Antigravity', exitCode: 0 }, CHECKED_AT)
  assert.equal(notPanel.authentication.state, 'unavailable')
  assert.equal(notPanel.usage, null)

  assert.equal(parseAntigravityStatus({ timedOut: true, stdout: PANEL }, CHECKED_AT).usage, null)
  assert.equal(parseAntigravityStatus({ error: 'spawn failed', stdout: PANEL }, CHECKED_AT).usage, null)
})

test('parseAntigravityStatus derives used/remaining from the limiting group only', () => {
  // Gemini 40% remaining (60% used), Claude & GPT 100% → headline is Gemini.
  const fixture = PANEL.replace('99.81%', '40.00%')
  const { usage } = parseAntigravityStatus(result(fixture), CHECKED_AT)

  assert.equal(usage.usedPercent, 60)
  assert.equal(usage.remainingPercent, 40)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { codexPlanGate } from './providers.mjs'
import { selectHostFallbackProvider } from './automatic-routing.mjs'

function readyCodex(plan) {
  return {
    id: 'codex',
    name: 'Codex',
    installed: true,
    routeKind: 'subscription',
    chatExecution: 'supported',
    connectionState: 'ready',
    canConnect: true,
    connectReason: null,
    authentication: { state: 'authenticated', method: 'ChatGPT login', reason: 'Codex CLI reports an active login.', source: 'cli', checkedAt: 't', exactPlan: null },
    usage: { availability: 'partial', source: 'cli', kind: 'subscription_quota', plan, model: 'gpt-5.6-terra', usedPercent: 7, remainingPercent: 93 },
  }
}

test('a Codex account on the ChatGPT Free plan is unavailable for routing with a factual reason', () => {
  const gated = codexPlanGate(readyCodex('free'))
  assert.equal(gated.connectionState, 'unavailable')
  assert.equal(gated.installed, true)
  assert.equal(gated.authentication.state, 'authenticated')
  assert.match(gated.authentication.reason, /Free plan/)
  assert.match(gated.authentication.reason, /paid subscription/)
  assert.equal(gated.connectReason, gated.authentication.reason)
  // Usage the CLI reported is still shown; nothing is inferred or hidden.
  assert.equal(gated.usage.usedPercent, 7)
  assert.equal(gated.usage.plan, 'free')
})

test('paid or unreported Codex plans keep the status untouched', () => {
  for (const plan of ['pro', 'plus', 'team', 'enterprise', 'Pro', null, undefined]) {
    const status = readyCodex(plan)
    assert.equal(codexPlanGate(status), status, `plan ${plan} must not be gated`)
  }
})

test('the gate only applies to a ready Codex status', () => {
  const claude = { ...readyCodex('free'), id: 'claude', name: 'Claude Code' }
  assert.equal(codexPlanGate(claude), claude)
  const needsLogin = { ...readyCodex('free'), connectionState: 'needs_authentication' }
  assert.equal(codexPlanGate(needsLogin), needsLogin)
  assert.equal(codexPlanGate(null), null)
})

test('a gated Codex is skipped by Host-side automatic fallback in favor of the next provider', () => {
  const claude = { ...readyCodex('max'), id: 'claude', name: 'Claude Code', usage: { usedPercent: 30, plan: 'max' } }
  const selected = selectHostFallbackProvider([codexPlanGate(readyCodex('free')), claude], [], ['codex', 'claude', 'droid'])
  assert.equal(selected?.id, 'claude')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseClaudeUsageProbe, probeClaudeUsage } from './claude-usage.mjs'

function probeResult(terminal) {
  return {
    exitCode: 0,
    error: null,
    timedOut: false,
    stderr: '',
    stdout: [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        claude_code_version: '2.1.223',
      }),
      JSON.stringify(terminal),
    ].join('\n'),
  }
}

test('Claude usage parser accepts only zero-cost local usage output', () => {
  const usage = parseClaudeUsageProbe(probeResult({
    type: 'result',
    is_error: false,
    num_turns: 0,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    result: 'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 18% used\nCurrent week (all models): 76% used · resets Aug 9 at 12:59am (Asia/Jerusalem)\nCurrent week (Fable): 91% used',
  }), '2026-08-06T09:00:00.000Z', 'max')

  assert.equal(usage.usedPercent, 76)
  assert.equal(usage.kind, 'subscription_quota')
  assert.equal(usage.remainingPercent, 24)
  assert.equal(usage.plan, 'max')
  assert.equal(usage.resetAt, null)
  assert.equal(usage.resetLabel, 'Aug 9 at 12:59am (Asia/Jerusalem)')
  assert.equal(usage.resetWindow, 'Week (all models)')
  assert.deepEqual(usage.details, [
    { label: 'Week (all models)', value: '76% used · resets Aug 9 at 12:59am (Asia/Jerusalem)' },
    { label: 'Current session', value: '18% used' },
  ])
  assert.match(usage.reason, /did not include a year or absolute timestamp/)
})

test('Claude usage parser preserves an exact reset label without calendar inference', () => {
  const usage = parseClaudeUsageProbe(probeResult({
    type: 'result',
    is_error: false,
    num_turns: 0,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    result: 'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 0% used\nCurrent week (all models): 100% used · resets Aug 9 at 1am (Asia/Jerusalem)\nCurrent week (Fable): 97% used · resets Aug 9 at 1am (Asia/Jerusalem)',
  }), '2026-08-06T18:17:34.899Z', 'max')

  assert.equal(usage.usedPercent, 100)
  assert.equal(usage.resetAt, null)
  assert.equal(usage.resetLabel, 'Aug 9 at 1am (Asia/Jerusalem)')
  assert.equal(usage.resetWindow, 'Week (all models)')
})

test('Claude usage parser withholds reset text from an unverified CLI version but keeps exact usage', () => {
  const result = probeResult({
    type: 'result',
    is_error: false,
    num_turns: 0,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    result: 'You are currently using your subscription\nCurrent week (all models): 50% used · resets tomorrow',
  })
  result.stdout = result.stdout.replace('2.1.223', '2.2.0')

  const usage = parseClaudeUsageProbe(result)
  assert.equal(usage.usedPercent, 50)
  assert.equal(usage.resetAt, null)
  assert.equal(usage.resetLabel, null)
  assert.equal(usage.resetWindow, null)
  assert.match(usage.reason, /outside Ensync's tested 2\.1\.223 format/)
})

test('Claude usage parser reports honestly when no reset field exists', () => {
  const usage = parseClaudeUsageProbe(probeResult({
    type: 'result',
    is_error: false,
    num_turns: 0,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    result: 'You are currently using your subscription\nCurrent session: 12% used',
  }))

  assert.equal(usage.resetLabel, null)
  assert.equal(usage.resetWindow, null)
  assert.match(usage.reason, /did not report a reset schedule/)
})

test('Claude usage parser rejects output that consumed a model turn', () => {
  assert.equal(parseClaudeUsageProbe(probeResult({
    type: 'result',
    is_error: false,
    num_turns: 1,
    duration_api_ms: 42,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    result: 'You are currently using your subscription\nCurrent week (all models): 50% used',
  })), null)
})

const subscriptionReport = () => probeResult({
  type: 'result',
  is_error: false,
  num_turns: 0,
  duration_api_ms: 0,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  result: 'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 12% used\nCurrent week (all models): 74% used',
})

const killedByTimeout = () => ({
  exitCode: 143,
  error: null,
  timedOut: true,
  timeoutReason: 'hard_limit',
  stdout: '',
  stderr: '',
})

test('Claude usage probe gives the /usage read more time than a plain CLI call', async () => {
  const calls = []
  const usage = await probeClaudeUsage('/opt/homebrew/bin/claude', '2026-08-10T18:00:00.000Z', 'max', {
    runProcess: async (executable, args, options) => {
      calls.push({ executable, args, options })
      return subscriptionReport()
    },
  })

  assert.equal(usage.usedPercent, 74)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].executable, '/opt/homebrew/bin/claude')
  assert.equal(calls[0].options.input, '/usage')
  // A full `claude --print /usage` round trip was measured at 4-13s on a healthy
  // Mac, so the old 8s ceiling killed the read whenever the machine was busy.
  assert.ok(
    calls[0].options.timeoutMs >= 30_000,
    `expected a ceiling above the measured worst case, got ${calls[0].options.timeoutMs}`,
  )
})

test('a killed /usage probe is retried once before reporting no usage', async () => {
  let attempts = 0
  const usage = await probeClaudeUsage('/opt/homebrew/bin/claude', '2026-08-10T18:00:00.000Z', null, {
    runProcess: async () => {
      attempts += 1
      return attempts === 1 ? killedByTimeout() : subscriptionReport()
    },
  })

  assert.equal(attempts, 2)
  assert.equal(usage?.usedPercent, 74)
})

test('two killed /usage probes report no usage without a third attempt', async () => {
  let attempts = 0
  const usage = await probeClaudeUsage('/opt/homebrew/bin/claude', '2026-08-10T18:00:00.000Z', null, {
    runProcess: async () => {
      attempts += 1
      return killedByTimeout()
    },
  })

  assert.equal(attempts, 2)
  assert.equal(usage, null)
})

test('a completed CLI answer that reports no subscription quota is not retried', async () => {
  let attempts = 0
  const usage = await probeClaudeUsage('/opt/homebrew/bin/claude', '2026-08-10T18:00:00.000Z', null, {
    runProcess: async () => {
      attempts += 1
      return probeResult({
        type: 'result',
        is_error: false,
        num_turns: 0,
        duration_api_ms: 0,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        result: 'You are currently using a paid API key for your Claude Code usage',
      })
    },
  })

  assert.equal(attempts, 1)
  assert.equal(usage, null)
})

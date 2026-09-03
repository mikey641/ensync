import assert from 'node:assert/strict'
import test from 'node:test'
import {
  droidLimitsExpectScript,
  parseDroidLimitsCapture,
  probeDroidLimits,
} from './droid-limits.mjs'

const CHECKED_AT = '2026-08-10T10:00:00.000Z'

// Verbatim panel lines from the live droid 0.191.1 capture after
// command.mjs cleanOutput, with only trailing box padding shortened.
function limitsFrame({
  fiveHour = '5-hour   38%                        ↻ 3h 21min',
  weekly = 'Weekly   14%                          ↻ 6 days',
  monthly = 'Monthly  4%                          ↻ 29 days',
  tab = '◉ Standard | ○ Droid Core | ○ Extra Usage',
  footer = '╰─ ───Configure Extra Usage on the billing page ($0.00 remaining)───╯',
} = {}) {
  return [
    '│ ⓘ  How Factory\'s usage works                                       │',
    '│ ● You are using Standard Usage.                                    │',
    '│ Usage & Limits                                                     │',
    ...(tab ? [`│ ${tab}                                                  │`] : []),
    ...(fiveHour ? [`│ ${fiveHour} │`] : []),
    '│ ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │',
    ...(weekly ? [`│ ${weekly} │`] : []),
    ...(monthly ? [`│ ${monthly} │`] : []),
    '│ When limit is reached                                              │',
    '│ > Switch to Droid Core                                             │',
    footer,
  ].join('\n')
}

function captureResult(stdout, overrides = {}) {
  return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout, ...overrides }
}

test('Droid limits parser reports the most-used Standard window from repeated frames', () => {
  const stdout = [limitsFrame(), limitsFrame(), limitsFrame()].join('\n')
  const usage = parseDroidLimitsCapture(captureResult(stdout), CHECKED_AT)

  assert.equal(usage.availability, 'partial')
  assert.equal(usage.source, 'cli')
  assert.equal(usage.kind, 'subscription_quota')
  assert.equal(usage.plan, null)
  assert.equal(usage.model, null)
  assert.equal(usage.usedPercent, 38)
  assert.equal(usage.remainingPercent, 62)
  assert.equal(usage.resetAt, null)
  assert.equal(usage.resetLabel, '3h 21min')
  assert.equal(usage.resetWindow, '5-hour')
  assert.equal(usage.checkedAt, CHECKED_AT)
  assert.deepEqual(usage.details, [
    { label: 'Quota type', value: 'Subscription quota (Standard)' },
    { label: '5-hour', value: '38% used · resets in 3h 21min' },
    { label: 'Weekly', value: '14% used · resets in 6 days' },
    { label: 'Monthly', value: '4% used · resets in 29 days' },
    { label: 'Extra Usage', value: '$0.00 remaining' },
  ])
  assert.match(usage.reason, /\/limits/)
  assert.match(usage.reason, /5-hour/)
  assert.match(usage.reason, /relative/)
})

test('Droid limits parser picks whichever window is most used', () => {
  const stdout = limitsFrame({
    fiveHour: '5-hour   12%   ↻ 3h 21min',
    weekly: 'Weekly   84%   ↻ 6 days',
    monthly: 'Monthly  91%   ↻ 29 days',
  })
  const usage = parseDroidLimitsCapture(captureResult(stdout), CHECKED_AT)

  assert.equal(usage.usedPercent, 91)
  assert.equal(usage.remainingPercent, 9)
  assert.equal(usage.resetWindow, 'Monthly')
  assert.equal(usage.resetLabel, '29 days')
})

test('Droid limits parser accepts decimal percentages and a missing reset arrow', () => {
  const stdout = limitsFrame({
    fiveHour: '5-hour   38.5%   ↻ 3h 21min',
    weekly: 'Weekly   100%',
    monthly: 'Monthly  4%   ↻ 29 days',
  })
  const usage = parseDroidLimitsCapture(captureResult(stdout), CHECKED_AT)

  assert.equal(usage.usedPercent, 100)
  assert.equal(usage.remainingPercent, 0)
  assert.equal(usage.resetWindow, 'Weekly')
  assert.equal(usage.resetLabel, null)
  assert.equal(usage.details[2].value, '100% used')
})

// Verbatim from a live droid 0.191.1 capture once the 5-hour window had reset:
// at 0% the panel replaces the ↻ countdown with a call to action, and treating
// that row as unreadable used to void the whole panel.
test('Droid limits parser reads a window whose countdown is replaced by a call to action', () => {
  const fiveHour = '5-hour   0%                                  Use Droid to start'
  const stdout = [limitsFrame({ fiveHour }), limitsFrame({ fiveHour })].join('\n')
  const usage = parseDroidLimitsCapture(captureResult(stdout), CHECKED_AT)

  assert.equal(usage.usedPercent, 14)
  assert.equal(usage.remainingPercent, 86)
  assert.equal(usage.resetWindow, 'Weekly')
  assert.equal(usage.resetLabel, '6 days')
  assert.deepEqual(usage.details, [
    { label: 'Quota type', value: 'Subscription quota (Standard)' },
    { label: '5-hour', value: '0% used' },
    { label: 'Weekly', value: '14% used · resets in 6 days' },
    { label: 'Monthly', value: '4% used · resets in 29 days' },
    { label: 'Extra Usage', value: '$0.00 remaining' },
  ])
})

test('Droid limits parser still rejects a window row without a readable percentage', () => {
  assert.equal(
    parseDroidLimitsCapture(
      captureResult(limitsFrame({ fiveHour: '5-hour   --   Use Droid to start' })),
      CHECKED_AT,
    ),
    null,
  )
})

test('Droid limits parser rejects frames that disagree on a percentage', () => {
  const stdout = [
    limitsFrame(),
    limitsFrame({ fiveHour: '5-hour   39%   ↻ 3h 21min' }),
  ].join('\n')
  assert.equal(parseDroidLimitsCapture(captureResult(stdout), CHECKED_AT), null)
})

test('Droid limits parser keeps the freshest reset label when only the countdown ticks', () => {
  const stdout = [
    limitsFrame({ fiveHour: '5-hour   38%   ↻ 3h 21min' }),
    limitsFrame({ fiveHour: '5-hour   38%   ↻ 3h 20min' }),
  ].join('\n')
  const usage = parseDroidLimitsCapture(captureResult(stdout), CHECKED_AT)

  assert.equal(usage.usedPercent, 38)
  assert.equal(usage.resetLabel, '3h 20min')
})

test('Droid limits parser requires all three Standard windows', () => {
  assert.equal(
    parseDroidLimitsCapture(captureResult(limitsFrame({ monthly: null })), CHECKED_AT),
    null,
  )
})

test('Droid limits parser requires proof that the Standard tab was selected', () => {
  assert.equal(
    parseDroidLimitsCapture(captureResult(limitsFrame({ tab: null })), CHECKED_AT),
    null,
  )
  assert.equal(
    parseDroidLimitsCapture(
      captureResult(limitsFrame({ tab: '○ Standard | ◉ Droid Core | ○ Extra Usage' })),
      CHECKED_AT,
    ),
    null,
  )
})

test('Droid limits parser rejects percentages above 100', () => {
  assert.equal(
    parseDroidLimitsCapture(
      captureResult(limitsFrame({ fiveHour: '5-hour   140%   ↻ 3h 21min' })),
      CHECKED_AT,
    ),
    null,
  )
})

test('Droid limits parser treats the Extra Usage balance as optional', () => {
  const stdout = limitsFrame({ footer: '╰────────────────────────────╯' })
  const usage = parseDroidLimitsCapture(captureResult(stdout), CHECKED_AT)

  assert.equal(usage.usedPercent, 38)
  assert.equal(usage.details.some((detail) => detail.label === 'Extra Usage'), false)
})

test('Droid limits parser rejects disagreeing Extra Usage balances', () => {
  const stdout = [
    limitsFrame(),
    limitsFrame({ footer: '╰─ Configure Extra Usage on the billing page ($5.00 remaining)─╯' }),
  ].join('\n')
  assert.equal(parseDroidLimitsCapture(captureResult(stdout), CHECKED_AT), null)
})

test('Droid limits parser refuses failed or timed-out captures', () => {
  const stdout = limitsFrame()
  assert.equal(parseDroidLimitsCapture(captureResult(stdout, { timedOut: true }), CHECKED_AT), null)
  assert.equal(parseDroidLimitsCapture(captureResult(stdout, { exitCode: 1 }), CHECKED_AT), null)
  assert.equal(parseDroidLimitsCapture(captureResult(stdout, { error: 'spawn failed' }), CHECKED_AT), null)
  assert.equal(parseDroidLimitsCapture(captureResult(''), CHECKED_AT), null)
  assert.equal(parseDroidLimitsCapture(null, CHECKED_AT), null)
})

test('Droid limits parser strips residual OSC and bare escape sequences', () => {
  const stdout = `\u001b]0;Droid\u0007\u001b\u001b[?25l${limitsFrame()}`
  const usage = parseDroidLimitsCapture(captureResult(stdout), CHECKED_AT)
  assert.equal(usage.usedPercent, 38)
})

test('Droid limits expect script drives the real TUI /limits command', () => {
  const script = droidLimitsExpectScript('/Users/someone/.local/bin/droid')

  assert.match(script, /spawn -noecho \{\/Users\/someone\/\.local\/bin\/droid\}/)
  assert.match(script, /stty rows 50 columns 120/)
  assert.match(script, /send "\/limits\\r"/)
  assert.match(script, /5-hour/)
})

test('Droid limits expect script refuses executables with Tcl-special characters', () => {
  assert.equal(droidLimitsExpectScript('/bin/dro{id'), null)
  assert.equal(droidLimitsExpectScript('/bin/dro}id'), null)
  assert.equal(droidLimitsExpectScript('/bin/dro"id'), null)
  assert.equal(droidLimitsExpectScript('/bin/dro$id'), null)
  assert.equal(droidLimitsExpectScript('/bin/dro[id'), null)
  assert.equal(droidLimitsExpectScript('/bin/dro\\id'), null)
  assert.equal(droidLimitsExpectScript('/bin/dro\nid'), null)
  assert.equal(droidLimitsExpectScript(''), null)
  assert.equal(droidLimitsExpectScript(null), null)
  assert.notEqual(droidLimitsExpectScript('/path with spaces/droid'), null)
})

test('Droid limits probe returns usage through an injected expect run', async () => {
  const calls = []
  const usage = await probeDroidLimits('/usr/local/bin/droid', CHECKED_AT, {
    findExecutable: async (command) => {
      calls.push(['find', command])
      return '/usr/bin/expect'
    },
    mkdir: async (path, options) => {
      calls.push(['mkdir', path, options])
    },
    runProcess: async (executable, args, options) => {
      calls.push(['run', executable, args, options.cwd, options.env.TERM])
      assert.match(options.input, /send "\/limits\\r"/)
      return captureResult(limitsFrame())
    },
    home: '/Users/probe-home',
  })

  assert.equal(usage.usedPercent, 38)
  assert.deepEqual(calls[0], ['find', 'expect'])
  assert.deepEqual(calls[1], ['mkdir', '/Users/probe-home/.ensync/droid-limits-probe-v1', { recursive: true, mode: 0o700 }])
  assert.deepEqual(calls[2], ['run', '/usr/bin/expect', ['-f', '-'], '/Users/probe-home/.ensync/droid-limits-probe-v1', 'xterm-256color'])
})

// The droid TUI indexes whatever directory it starts in. Started in the home
// directory it walks Contacts, Photos, Documents, and other apps' containers,
// and macOS raises a privacy prompt attributed to Ensync on every probe. The
// probe therefore always starts the TUI in an empty Ensync-owned directory,
// and refuses to run at all when that directory cannot be created.
test('Droid limits probe never starts the TUI in the home directory', async () => {
  const cwds = []
  await probeDroidLimits('/usr/local/bin/droid', CHECKED_AT, {
    findExecutable: async () => '/usr/bin/expect',
    mkdir: async () => {},
    runProcess: async (_executable, _args, options) => {
      cwds.push(options.cwd)
      return captureResult(limitsFrame())
    },
    home: '/Users/probe-home',
  })
  assert.deepEqual(cwds, ['/Users/probe-home/.ensync/droid-limits-probe-v1'])

  const runs = []
  const usage = await probeDroidLimits('/usr/local/bin/droid', CHECKED_AT, {
    findExecutable: async () => '/usr/bin/expect',
    mkdir: async () => {
      throw new Error('EROFS: read-only file system')
    },
    runProcess: async (_executable, _args, options) => {
      runs.push(options.cwd)
      return captureResult(limitsFrame())
    },
    home: '/Users/probe-home',
  })
  assert.equal(usage, null)
  assert.deepEqual(runs, [])
})

test('Droid limits probe degrades to null without expect or with a rejected executable', async () => {
  assert.equal(
    await probeDroidLimits('/usr/local/bin/droid', CHECKED_AT, {
      findExecutable: async () => null,
      runProcess: async () => {
        throw new Error('must not run')
      },
    }),
    null,
  )
  assert.equal(
    await probeDroidLimits('/bin/dro{id', CHECKED_AT, {
      findExecutable: async () => '/usr/bin/expect',
      runProcess: async () => {
        throw new Error('must not run')
      },
    }),
    null,
  )
})

test('an empty capture is retried once before reporting no usage', async () => {
  const captures = []
  const panel = [
    '│ ◉ Standard | ○ Droid Core | ○ Extra Usage │',
    '│ 5-hour   0%                  Use Droid to start │',
    '│ Weekly   15%                          ↻ 6 days │',
    '│ Monthly  4%                          ↻ 29 days │',
  ].join('\n')

  const result = await probeDroidLimits('/test/bin/droid', '2026-08-10T18:00:00.000Z', {
    findExecutable: async () => '/usr/bin/expect',
    runProcess: async () => {
      captures.push(1)
      return captures.length === 1
        ? { exitCode: 0, error: null, timedOut: false, stdout: '', stderr: '' }
        : { exitCode: 0, error: null, timedOut: false, stdout: panel, stderr: '' }
    },
  })

  assert.equal(captures.length, 2)
  assert.equal(result?.usedPercent, 15)
  assert.equal(result?.resetWindow, 'Weekly')
})

test('two empty captures report no usage without a third probe', async () => {
  let captures = 0
  const result = await probeDroidLimits('/test/bin/droid', '2026-08-10T18:00:00.000Z', {
    findExecutable: async () => '/usr/bin/expect',
    runProcess: async () => {
      captures += 1
      return { exitCode: 0, error: null, timedOut: false, stdout: '', stderr: '' }
    },
  })
  assert.equal(captures, 2)
  assert.equal(result, null)
})

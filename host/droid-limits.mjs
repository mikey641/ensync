import { homedir } from 'node:os'
import { findExecutable, runProcess, subscriptionEnvironment } from './command.mjs'

// Verified against droid 0.191.1: `/limits` exists only in the interactive TUI.
// The exec stream-jsonrpc surface registers zero commands (droid.list_commands
// returns an empty list) and has no limits method, so sending "/limits" through
// droid.add_user_message would reach the model as prompt text and consume a
// turn. Every `droid daemon` method is gated by daemon.authenticate, which
// validates a real Factory access token server-side, and the local credential
// store is encrypted, which Ensync never reads (see droid-auth.mjs).
//
// The TUI's /limits panel performs a billing API GET — no model turn, no quota
// consumed — and renders one plain-text line per Standard window. Ensync
// therefore drives the real TUI in a disposable PTY through the OS-provided
// expect(1), sends the /limits command, and strictly parses the panel. Values
// repeat identically on every repaint, so the parser accepts a percentage only
// when all of its rendered occurrences agree and returns null otherwise; a TUI
// redesign or an untrusted-folder prompt degrades to the honest "capacity
// unknown" fallback rather than a wrong number.
const TUI_STARTUP_WAIT_SECONDS = 8
const PANEL_WAIT_SECONDS = 15
const PANEL_DRAIN_SECONDS = 3
const PROBE_TIMEOUT_MS = 35_000
const MAX_CAPTURE_BYTES = 512 * 1024

// The executable path is embedded in a Tcl brace word, where these characters
// would change parsing. Droid installs never contain them, so the probe refuses
// such paths outright instead of attempting Tcl escaping.
const TCL_UNSAFE_PATTERN = /[{}[\]$"\\]|[\u0000-\u001f\u007f]/

// One entry per Standard window line, matched against the whole cleaned
// capture. Everything between the percentage and the right border is a free
// annotation column, so the row stays readable whichever copy droid puts
// there: `↻ 3h 21min` while the window counts down, "Use Droid to start" once
// it has reset to 0%, or nothing at all. Only a `↻` annotation is a reset
// countdown; any other copy leaves the reset unreported rather than voiding
// the whole panel.
const WINDOW_PATTERNS = ['5-hour', 'Weekly', 'Monthly'].map((label) => ({
  label,
  pattern: new RegExp(`^\\s*│\\s*${label}\\s+([0-9]+(?:\\.[0-9]+)?)%\\s*([^│]*?)\\s*│\\s*$`),
}))
const RESET_ANNOTATION_PATTERN = /^↻\s+(.+)$/
// The filled radio glyph proves which billing pool the percentages belong to.
const STANDARD_TAB_PATTERN = /^\s*│\s*◉ Standard\s*\|/
const EXTRA_USAGE_PATTERN = /\(\$([0-9][0-9,]*\.[0-9]{2}) remaining\)/

// runProcess already strips CSI sequences; the TUI also emits OSC titles and
// bare escapes that must not be allowed to split or pollute a panel line.
function stripResidualEscapes(text) {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b./g, '')
}

function numericPercent(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null
}

function windowReadings(lines, { label, pattern }) {
  const readings = lines.flatMap((line) => {
    const match = line.match(pattern)
    if (!match) return []
    const countdown = match[2].match(RESET_ANNOTATION_PATTERN)
    return [{ usedPercent: numericPercent(match[1]), resetLabel: countdown?.[1].trim() || null }]
  })
  if (readings.length === 0) return null
  if (readings.some((reading) => reading.usedPercent === null)) return null
  if (new Set(readings.map((reading) => reading.usedPercent)).size > 1) return null
  return {
    label,
    usedPercent: readings[0].usedPercent,
    // The countdown may tick between repaints, so the freshest frame wins.
    resetLabel: readings.at(-1).resetLabel,
  }
}

function extraUsageBalance(lines) {
  const amounts = lines.flatMap((line) => {
    const match = line.match(EXTRA_USAGE_PATTERN)
    return match ? [match[1]] : []
  })
  if (amounts.length === 0) return { present: false, amount: null }
  if (new Set(amounts).size > 1) return null
  return { present: true, amount: amounts[0] }
}

export function parseDroidLimitsCapture(result, checkedAt = new Date().toISOString()) {
  if (!result || result.timedOut || result.error || result.exitCode !== 0
    || typeof result.stdout !== 'string') return null
  const lines = stripResidualEscapes(result.stdout).split('\n')
  if (!lines.some((line) => STANDARD_TAB_PATTERN.test(line))) return null

  const windows = WINDOW_PATTERNS.map((entry) => windowReadings(lines, entry))
  if (windows.some((window) => window === null)) return null
  const extraUsage = extraUsageBalance(lines)
  if (extraUsage === null) return null

  const limitingWindow = [...windows].sort((left, right) => right.usedPercent - left.usedPercent)[0]
  const details = [
    { label: 'Quota type', value: 'Subscription quota (Standard)' },
    ...windows.map((window) => ({
      label: window.label,
      value: `${window.usedPercent}% used${window.resetLabel ? ` · resets in ${window.resetLabel}` : ''}`,
    })),
    ...(extraUsage.present ? [{ label: 'Extra Usage', value: `$${extraUsage.amount} remaining` }] : []),
  ]

  return {
    availability: 'partial',
    source: 'cli',
    kind: 'subscription_quota',
    plan: null,
    model: null,
    usedPercent: limitingWindow.usedPercent,
    remainingPercent: Math.max(0, 100 - limitingWindow.usedPercent),
    // Droid reports resets only as relative durations, so Ensync never derives
    // an absolute timestamp from them.
    resetAt: null,
    resetLabel: limitingWindow.resetLabel,
    resetWindow: limitingWindow.label,
    checkedAt,
    details,
    reason: `Factory Droid's /limits view reported exact Standard usage for the most-used ${limitingWindow.label} window. Droid states reset times only as relative durations, so Ensync does not derive absolute timestamps.`,
  }
}

export function droidLimitsExpectScript(executable) {
  if (typeof executable !== 'string' || !executable.trim()) return null
  if (TCL_UNSAFE_PATTERN.test(executable)) return null
  // The startup wait is a blind delay on purpose: the TUI's ready banner copy
  // churns across droid's weekly auto-updates, while a too-early "/limits" only
  // yields a capture the strict parser rejects. The panel wait matches on the
  // 5-hour row itself and the final drain collects the full repaint set.
  return [
    'set timeout 40',
    'log_user 1',
    `spawn -noecho {${executable}}`,
    'stty rows 50 columns 120 < $spawn_out(slave,name)',
    `expect -timeout ${TUI_STARTUP_WAIT_SECONDS} __ensync_droid_limits_never_matches__`,
    'send "/limits\\r"',
    `expect -timeout ${PANEL_WAIT_SECONDS} -re {5-hour +[0-9]}`,
    `expect -timeout ${PANEL_DRAIN_SECONDS} __ensync_droid_limits_never_matches__`,
    'exit 0',
    '',
  ].join('\n')
}

export async function probeDroidLimits(executable, checkedAt, options = {}) {
  const script = droidLimitsExpectScript(executable)
  if (!script) return null
  const locate = options.findExecutable ?? findExecutable
  const expectExecutable = await locate('expect')
  if (!expectExecutable) return null
  const capture = async () => runCapture(expectExecutable, script, checkedAt, options)
  const first = await capture()
  if (first) return first
  // Two probes racing (a manual refresh landing on a scheduled one) leave the
  // second TUI without the panel, and one empty capture would blank reported
  // usage until the next poll. A single retry costs one more panel read and
  // never consumes quota, since the panel is a billing read, not a model turn.
  return options.retryOnEmptyCapture === false ? null : capture()
}

async function runCapture(expectExecutable, script, checkedAt, options) {
  const run = options.runProcess ?? runProcess
  const result = await run(expectExecutable, ['-f', '-'], {
    input: script,
    // The home directory is the least surprising trusted folder; when droid
    // does not trust it, the trust prompt blocks the panel and the parse
    // degrades to the unavailable fallback.
    cwd: options.home ?? homedir(),
    env: { ...subscriptionEnvironment(), TERM: 'xterm-256color' },
    timeoutMs: PROBE_TIMEOUT_MS,
    maxCaptureBytes: MAX_CAPTURE_BYTES,
  })
  return parseDroidLimitsCapture(result, checkedAt)
}

import { runProcess } from './command.mjs'

const TESTED_RESET_TEXT_VERSION = Object.freeze({ major: 2, minor: 1, minimumPatch: 223 })
const RESET_TEXT_PATTERN = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12][0-9]|3[01]) at (1[0-2]|[1-9])(?::([0-5][0-9]))?(am|pm) \(([A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*)\)$/

function numericPercent(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null
}

function zeroTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return false
  return [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].every((value) => value === 0)
}

function claudeVersion(events) {
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init')
  return typeof init?.claude_code_version === 'string' ? init.claude_code_version.trim() : null
}

function supportsResetText(version) {
  const match = typeof version === 'string' ? version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/) : null
  if (!match) return false
  const [, major, minor, patch] = match.map(Number)
  return major === TESTED_RESET_TEXT_VERSION.major
    && minor === TESTED_RESET_TEXT_VERSION.minor
    && patch >= TESTED_RESET_TEXT_VERSION.minimumPatch
}

function exactResetLabel(value, version) {
  if (!supportsResetText(version) || typeof value !== 'string') return null
  const label = value.trim()
  const match = label.match(RESET_TEXT_PATTERN)
  if (!match) return null

  // Validate the explicitly reported IANA zone without deriving an absolute date. Claude's
  // current text omits the year, so converting this label to ISO would require calendar inference.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: match[6] }).format(0)
  } catch {
    return null
  }
  return label
}

function windowDisplayName(label) {
  return label.toLowerCase() === 'session' ? 'Current session' : 'Week (all models)'
}

export function parseClaudeUsageProbe(result, checkedAt = new Date().toISOString(), plan = null) {
  if (result?.timedOut || result?.error || result?.exitCode !== 0 || typeof result.stdout !== 'string') return null
  const events = result.stdout.split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line)
      return event && typeof event === 'object' ? [event] : []
    } catch {
      return []
    }
  })
  const version = claudeVersion(events)
  const terminal = [...events].reverse().find((event) => event.type === 'result')
  if (
    !terminal
    || terminal.is_error !== false
    || terminal.num_turns !== 0
    || terminal.duration_api_ms !== 0
    || terminal.total_cost_usd !== 0
    || !zeroTokenUsage(terminal.usage)
    || typeof terminal.result !== 'string'
    || !terminal.result.includes('using your subscription')
  ) return null

  const windows = terminal.result.split('\n').flatMap((line) => {
    const match = line.match(/^Current (session|week \(all models\)): ([0-9]+(?:\.[0-9]+)?)% used(?: · resets (.+))?$/i)
    if (!match) return []
    const usedPercent = numericPercent(match[2])
    return usedPercent === null ? [] : [{
      label: match[1],
      usedPercent,
      resetLabel: exactResetLabel(match[3], version),
      resetTextWasPresent: Boolean(match[3]?.trim()),
    }]
  })
  const limitingWindow = windows.sort((left, right) => {
    const usageDifference = right.usedPercent - left.usedPercent
    return usageDifference || Number(Boolean(right.resetLabel)) - Number(Boolean(left.resetLabel))
  })[0]
  if (!limitingWindow) return null

  const resetWindow = limitingWindow.resetLabel
    ? limitingWindow
    : windows.find((window) => window.resetLabel) ?? null
  const unparsedResetWasPresent = windows.some((window) => window.resetTextWasPresent && !window.resetLabel)
  const details = windows.map((window) => ({
    label: windowDisplayName(window.label),
    value: `${window.usedPercent}% used${window.resetLabel ? ` · resets ${window.resetLabel}` : ''}`,
  }))

  let resetReason = ' The CLI did not report a reset schedule for either provider-wide window.'
  if (resetWindow) {
    resetReason = ` The ${windowDisplayName(resetWindow.label).toLowerCase()} reset was reported exactly as ${resetWindow.resetLabel}; Claude did not include a year or absolute timestamp, so Ensync did not derive one.`
  } else if (unparsedResetWasPresent) {
    resetReason = version
      ? ` Claude ${version} returned reset text outside Ensync's tested 2.1.223 format, so the value remains unparsed.`
      : ' Claude returned reset text without a CLI version event, so the value remains unparsed.'
  }

  return {
    availability: 'partial',
    source: 'cli',
    kind: 'subscription_quota',
    plan,
    model: null,
    usedPercent: limitingWindow.usedPercent,
    remainingPercent: Math.max(0, 100 - limitingWindow.usedPercent),
    resetAt: null,
    resetLabel: resetWindow?.resetLabel ?? null,
    resetWindow: resetWindow ? windowDisplayName(resetWindow.label) : null,
    checkedAt,
    details,
    reason: `Claude Code /usage reported exact ${limitingWindow.usedPercent}% usage for the ${windowDisplayName(limitingWindow.label).toLowerCase()}.${resetReason}`,
  }
}

// `claude --print /usage` boots the whole CLI and performs a billing round trip
// before it prints anything, measured at 4-7s idle and up to 13s while the rest
// of the provider sweep runs its own CLIs alongside it. The former 8s ceiling
// sat inside that range, so a busy refresh killed the read mid-flight, left an
// empty capture, and blanked a percentage the previous refresh had shown. The
// ceiling is now a runaway backstop well clear of the measured worst case.
const PROBE_TIMEOUT_MS = 30_000

const PROBE_ARGS = Object.freeze([
  '--print',
  '--verbose',
  '--output-format',
  'stream-json',
  '--safe-mode',
  '--tools',
  '',
  '--no-session-persistence',
])

// Only a run that never delivered an answer is worth repeating. A CLI that
// exited cleanly and simply did not report subscription quota — an API-key
// account, say — would answer the same way every time, so retrying it would
// double the probe cost of every refresh for nothing.
function answeredCleanly(result) {
  return Boolean(result)
    && !result.timedOut
    && !result.error
    && result.exitCode === 0
    && typeof result.stdout === 'string'
    && result.stdout.trim() !== ''
}

export async function probeClaudeUsage(executable, checkedAt, plan, options = {}) {
  const run = options.runProcess ?? runProcess
  const attempt = () => run(executable, [...PROBE_ARGS], {
    input: '/usage',
    timeoutMs: PROBE_TIMEOUT_MS,
  })

  const first = await attempt()
  const usage = parseClaudeUsageProbe(first, checkedAt, plan)
  if (usage || answeredCleanly(first)) return usage
  // The retry covers the residue the higher ceiling cannot: a probe racing a
  // manual refresh, or a CLI that dies on startup. /usage consumes no quota and
  // no model turn, so a second read costs only time.
  if (options.retryOnFailedRead === false) return null
  return parseClaudeUsageProbe(await attempt(), checkedAt, plan)
}

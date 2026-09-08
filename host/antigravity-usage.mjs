import { mkdir as makeDirectory } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findExecutable, runProcess, subscriptionEnvironment } from './command.mjs'

// Antigravity exposes its signed-in Google account and per-model-group weekly
// quota only through the interactive TUI's /usage view (Models & Quota):
//   Account: mikey641@gmail.com
//   GEMINI MODELS
//     Weekly Limit Remaining   [████…] 99.81%
//     100% remaining · Refreshes in 156h 53m
//   CLAUDE AND GPT MODELS
//     Weekly Limit Remaining   [████…] 100.00%
//     Quota available
// Verified against agy 1.1.27 on macOS. Driving /usage is a billing read,
// never a model turn. There is no non-interactive status or usage command, so
// the TUI is the machine-readable surface.
//
// The TUI runs in this empty Ensync-owned directory so the probe never indexes
// a real project. A first run in a new directory shows a project-trust modal;
// the probe accepts "Yes, I trust this folder" for that empty directory only,
// so no user files, MCP servers, skills, commands, or configuration are loaded.
const PROBE_DIRECTORY_SEGMENTS = ['.ensync', 'antigravity-usage-probe-v1']
const TUI_STARTUP_WAIT_SECONDS = 20
const SETTLE_WAIT_SECONDS = 8
const USAGE_WAIT_SECONDS = 12
const PANEL_DRAIN_SECONDS = 4
const PROBE_TIMEOUT_MS = 40_000
const MAX_CAPTURE_BYTES = 512 * 1024

const TCL_UNSAFE_PATTERN = /[{}[\]$"\\]|[\u0000-\u001f\u007f]/

function numericPercent(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function groupDisplayName(header) {
  const words = header
    .replace(/MODELS$/i, '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => {
      if (word === 'and') return '&'
      if (word === 'gpt') return 'GPT'
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
  return words.length ? `${words.join(' ')} models` : null
}

function unavailable(reason, checkedAt) {
  return {
    state: 'unavailable',
    method: null,
    accountLogin: null,
    reason,
    source: 'cli',
    checkedAt,
    exactPlan: null,
  }
}

/**
 * Parses one /usage TUI capture into both the account authentication result
 * and the weekly model-group quota. The account is the first-party sign-in
 * proof; the headline percentage is the most-consumed (lowest remaining)
 * group, and the reset countdown is only the limiting group's own countdown.
 */
export function parseAntigravityStatus(result, checkedAt = new Date().toISOString()) {
  if (!result || result.timedOut || result.error) {
    return {
      authentication: unavailable('Antigravity usage timed out or could not be started.', checkedAt),
      usage: null,
    }
  }
  const text = typeof result.stdout === 'string' ? result.stdout : ''
  if (!text.includes('Models & Quota')) {
    return {
      authentication: unavailable(
        'Antigravity did not render its Models & Quota view, so the account check could not be confirmed.',
        checkedAt,
      ),
      usage: null,
    }
  }

  const accountMatch = text.match(/Account:\s*([^\s@]+@[^\s@]+)/)
  const accountLogin = accountMatch?.[1] ?? null

  const groups = []
  let currentGroup = null
  let state = 'idle'
  for (const line of text.split('\n')) {
    const headerMatch = line.trim().match(/^([A-Z][A-Z0-9 &-]+ MODELS)$/i)
    if (headerMatch) {
      currentGroup = headerMatch[1].trim()
      state = 'idle'
      continue
    }
    if (/Weekly Limit Remaining/i.test(line)) {
      state = 'bar'
      continue
    }
    if (state === 'bar') {
      const barMatch = line.trim().match(/\[[█ ]+\]\s*([0-9]+(?:\.[0-9]+)?)\s*%$/)
      if (barMatch && currentGroup) {
        groups.push({ header: currentGroup, remaining: numericPercent(barMatch[1]), resetLabel: null })
        state = 'caption'
      }
      continue
    }
    if (state === 'caption') {
      const caption = line.trim()
      if (!caption) continue
      const group = groups[groups.length - 1]
      if (group) {
        const refresh = caption.match(/Refreshes in\s+(.+)$/i)
        if (refresh) group.resetLabel = refresh[1].trim()
        else if (/Quota available/i.test(caption)) group.resetLabel = 'quota available'
      }
      state = 'idle'
    }
  }

  const verifiedGroups = groups.filter((group) => group.remaining !== null)
  if (!accountLogin || verifiedGroups.length === 0) {
    return {
      authentication: accountLogin
        ? {
            state: 'authenticated',
            method: 'Google account login',
            accountLogin,
            reason: "Antigravity's usage view reported the signed-in account.",
            source: 'cli',
            checkedAt,
            exactPlan: null,
          }
        : unavailable(
            'Antigravity usage did not report a signed-in account, so the account check could not be confirmed.',
            checkedAt,
          ),
      usage: null,
    }
  }

  const limitingGroup = [...verifiedGroups].sort((left, right) => left.remaining - right.remaining)[0]
  const remainingPercent = round(limitingGroup.remaining, 2)
  const usedPercent = round(Math.max(0, 100 - remainingPercent), 2)
  const details = verifiedGroups.map((group) => ({
    label: groupDisplayName(group.header),
    value: group.resetLabel
      ? `${group.remaining}% remaining · ${group.resetLabel.startsWith('quota') ? group.resetLabel : `refreshes in ${group.resetLabel}`}`
      : `${group.remaining}% remaining`,
  }))

  return {
    authentication: {
      state: 'authenticated',
      method: 'Google account login',
      accountLogin,
      reason: "Antigravity's usage view reported the signed-in account.",
      source: 'cli',
      checkedAt,
      exactPlan: null,
    },
    usage: {
      availability: 'partial',
      source: 'cli',
      kind: 'subscription_quota',
      plan: null,
      model: null,
      usedPercent,
      remainingPercent,
      resetAt: null,
      resetLabel: limitingGroup.resetLabel?.startsWith('quota') ? null : limitingGroup.resetLabel,
      resetWindow: 'Weekly',
      checkedAt,
      details,
      reason: `Antigravity's Models & Quota view reported ${remainingPercent}% of the ${groupDisplayName(limitingGroup.header) ?? 'limiting group'} weekly limit remaining.`,
    },
  }
}

export function antigravityUsageExpectScript(executable) {
  if (typeof executable !== 'string' || !executable.trim()) return null
  if (TCL_UNSAFE_PATTERN.test(executable)) return null
  return [
    'set timeout 50',
    'log_user 1',
    `spawn -noecho {${executable}}`,
    'stty rows 60 columns 200 < $spawn_out(slave,name)',
    `expect -timeout ${TUI_STARTUP_WAIT_SECONDS} {`,
    '  "Do you trust the contents of this project" {',
    '    send "\\r"',
    `    expect -timeout ${SETTLE_WAIT_SECONDS} __ensync_agy_settle_never__`,
    '  }',
    '  timeout {}',
    '}',
    'send "/usage\\r"',
    `expect -timeout ${USAGE_WAIT_SECONDS} "Weekly Limit Remaining"`,
    `expect -timeout ${PANEL_DRAIN_SECONDS} __ensync_agy_usage_never__`,
    'exit 0',
    '',
  ].join('\n')
}

async function prepareProbeDirectory(options) {
  const directory = join(options.home ?? homedir(), ...PROBE_DIRECTORY_SEGMENTS)
  const mkdir = options.mkdir ?? makeDirectory
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  } catch {
    return null
  }
  return directory
}

/**
 * Runs the /usage TUI read once and returns both the account authentication
 * result and the weekly quota usage (Amp-style: one process serves both).
 */
export async function probeAntigravityStatus(executable, checkedAt = new Date().toISOString(), options = {}) {
  const script = antigravityUsageExpectScript(executable)
  if (!script) return parseAntigravityStatus({ error: 'unsafe-executable' }, checkedAt)
  const locate = options.findExecutable ?? findExecutable
  const expectExecutable = await locate('expect')
  if (!expectExecutable) return parseAntigravityStatus({ error: 'no-expect' }, checkedAt)
  const probeDirectory = await prepareProbeDirectory(options)
  if (!probeDirectory) return parseAntigravityStatus({ error: 'no-probe-directory' }, checkedAt)
  const run = options.runProcess ?? runProcess
  const result = await run(expectExecutable, ['-f', '-'], {
    input: script,
    cwd: probeDirectory,
    env: { ...subscriptionEnvironment(), TERM: 'xterm-256color' },
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    maxCaptureBytes: options.maxCaptureBytes ?? MAX_CAPTURE_BYTES,
  })
  return parseAntigravityStatus(result, checkedAt)
}

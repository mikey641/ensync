import { mkdir as makeDirectory } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findExecutable, runProcess, subscriptionEnvironment } from './command.mjs'

// Junie exposes its license and AI-credit balance only through the interactive
// TUI's /stats panel (License & quota tab):
//   License: No active license found
//   Balance left: 0.00 credits
// Verified against junie 26.8.31 on macOS. Driving /stats is a billing read,
// never a model turn, and it never creates a session. Junie has no
// non-interactive status or usage command, and the panel reports a raw credit
// balance with no included-allowance denominator or reset schedule, so Ensync
// shows the license and balance as details and never derives a percentage.
//
// The TUI runs in this empty Ensync-owned directory so the probe never indexes
// a real project. A first run in a new directory shows a project-trust modal;
// the probe accepts "Trust this project" for that empty directory only, so no
// user files, MCP servers, skills, commands, or configuration are ever loaded.
const PROBE_DIRECTORY_SEGMENTS = ['.ensync', 'junie-usage-probe-v1']
const TUI_STARTUP_WAIT_SECONDS = 20
const SETTLE_WAIT_SECONDS = 6
const STATS_WAIT_SECONDS = 15
const TAB_DRAIN_SECONDS = 4
const PANEL_DRAIN_SECONDS = 6
const PROBE_TIMEOUT_MS = 40_000
// Junie's Compose TUI redraws full color frames, so a single /stats read can
// exceed a megabyte before the terminal-escape cleanup. The budget is sized for
// that, not for a prompt (the panel is a billing read, never a model turn).
const MAX_CAPTURE_BYTES = 6 * 1024 * 1024

// The executable path is embedded in a Tcl brace word, where these characters
// would change parsing. Junie installs never contain them, so the probe refuses
// such paths outright instead of attempting Tcl escaping.
const TCL_UNSAFE_PATTERN = /[{}[\]$"\\]|[\u0000-\u001f\u007f]/

function collapsedToken(window) {
  const match = window.replace(/^\s+/, '').match(/^(.*?)(?=\s{2,}|$)/)
  if (!match) return null
  const token = match[1].replace(/[ \t\u00a0]+/g, ' ').trim()
  return token || null
}

/**
 * Parses one /stats TUI capture into the license state and raw credit balance.
 * Anchors on the freshest "Balance left:" rendering (the License & quota tab
 * repeats on every repaint), requires the panel header to be present, and
 * refuses to guess when the balance is missing or malformed.
 */
export function parseJunieUsage(result, checkedAt = new Date().toISOString()) {
  if (!result || result.timedOut || result.error) return null
  const text = typeof result.stdout === 'string' ? result.stdout : ''
  if (!text.includes('Current session') || !text.includes('License & quota')) return null

  const balanceKey = text.lastIndexOf('Balance left:')
  if (balanceKey < 0) return null
  const licenseKey = text.lastIndexOf('License:', balanceKey)
  if (licenseKey < 0 || balanceKey - licenseKey > 600) return null

  const license = collapsedToken(text.slice(licenseKey + 'License:'.length, licenseKey + 400))
  if (!license) return null
  const balanceRaw = collapsedToken(text.slice(balanceKey + 'Balance left:'.length, balanceKey + 400))
  const balanceMatch = balanceRaw && balanceRaw.match(/^(\d+(?:\.\d+)?)\s*(credits?|tokens?)?/i)
  if (!balanceMatch) return null
  const balance = balanceMatch[1]
  const unit = balanceMatch[2] ? balanceMatch[2].toLowerCase() : 'credits'

  return {
    // A raw balance with no included-allowance denominator is honest quota
    // detail, not a percentage. availability stays 'unavailable' so the card
    // never renders a fabricated meter.
    availability: 'unavailable',
    source: 'cli',
    kind: 'subscription_quota',
    plan: null,
    model: null,
    usedPercent: null,
    remainingPercent: null,
    resetAt: null,
    checkedAt,
    details: [
      { label: 'License', value: license },
      { label: 'Balance left', value: `${balance} ${unit}` },
    ],
    reason: `Junie's /stats view reported the license and a raw ${unit} balance without an included-allowance total or reset schedule, so Ensync shows the balance rather than a percentage.`,
  }
}

export function junieUsageExpectScript(executable) {
  if (typeof executable !== 'string' || !executable.trim()) return null
  if (TCL_UNSAFE_PATTERN.test(executable)) return null
  // The trust modal appears only on the first run in a new directory. Accept
  // it when present and otherwise leave the already-trusted main screen alone;
  // multiple tab presses advance /stats from "Current session" to the
  // "License & quota" tab whose content the parser reads.
  return [
    'set timeout 50',
    'log_user 1',
    `spawn -noecho {${executable}}`,
    'stty rows 50 columns 120 < $spawn_out(slave,name)',
    `expect -timeout ${TUI_STARTUP_WAIT_SECONDS} {`,
    '  "Junie needs your trust decision" {',
    '    send "\\r"',
    `    expect -timeout ${SETTLE_WAIT_SECONDS} __ensync_junie_settle_never__`,
    '  }',
    '  timeout {}',
    '}',
    'send "/stats\\r"',
    `expect -timeout ${STATS_WAIT_SECONDS} "License & quota"`,
    `expect -timeout ${TAB_DRAIN_SECONDS} __ensync_junie_stats_never__`,
    'send "\\t"',
    `expect -timeout ${TAB_DRAIN_SECONDS} __ensync_junie_tab1_never__`,
    'send "\\t"',
    `expect -timeout ${PANEL_DRAIN_SECONDS} __ensync_junie_tab2_never__`,
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
    // Without the empty directory the only alternative is a real project,
    // which is exactly what must never be indexed; unknown usage is the honest result.
    return null
  }
  return directory
}

export async function probeJunieUsage(executable, checkedAt = new Date().toISOString(), options = {}) {
  const script = junieUsageExpectScript(executable)
  if (!script) return null
  const locate = options.findExecutable ?? findExecutable
  const expectExecutable = await locate('expect')
  if (!expectExecutable) return null
  const probeDirectory = await prepareProbeDirectory(options)
  if (!probeDirectory) return null
  const run = options.runProcess ?? runProcess
  const result = await run(expectExecutable, ['-f', '-'], {
    input: script,
    // Never the home directory or a real project: see PROBE_DIRECTORY_SEGMENTS.
    cwd: probeDirectory,
    env: { ...subscriptionEnvironment(), TERM: 'xterm-256color' },
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    maxCaptureBytes: options.maxCaptureBytes ?? MAX_CAPTURE_BYTES,
  })
  return parseJunieUsage(result, checkedAt)
}

import { execFileSync } from 'node:child_process'

// A PID names a process only for as long as that process lives. The operating
// system reissues it afterwards — most visibly across a reboot, where the low
// PIDs a login-time daemon received are handed straight back out to system
// daemons, but also within one long session once the PID counter wraps. Every
// "is the process that wrote this record still running?" check therefore needs
// the pair (pid, start time), never the PID alone.
//
// Records already carry the instant they were written, so no schema change is
// needed: a process whose start time postdates the record cannot have written
// it. The comparison is against wall-clock timestamps, so a tolerance absorbs
// the one second `ps` truncates and any modest clock correction.
export const PROCESS_IDENTITY_TOLERANCE_MS = 60_000

const PROBE_TIMEOUT_MS = 2_000
// [[dd-]hh:]mm:ss — the POSIX elapsed-time format, and locale independent
// unlike the human-readable start date.
const ELAPSED_PATTERN = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function parseElapsedSeconds(value) {
  const match = ELAPSED_PATTERN.exec(String(value).trim())
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
}

function probe(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  })
}

/**
 * Wall-clock instant the process holding `pid` started, or null when that
 * cannot be established. Callers must treat null as "unknown", never as
 * "retired": refusing to answer must not be what unlocks a contended file.
 */
export function processStartTimeMs(pid, now = Date.now()) {
  if (!Number.isInteger(pid) || pid < 1) return null
  try {
    if (process.platform === 'win32') {
      const output = probe('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ])
      const parsed = Date.parse(output.trim())
      return Number.isFinite(parsed) ? parsed : null
    }
    const elapsed = parseElapsedSeconds(probe('ps', ['-o', 'etime=', '-p', String(pid)]))
    return elapsed === null ? null : now - elapsed * 1000
  } catch {
    // A dead PID, a denied probe, or a platform without either tool. The
    // caller keeps whatever guarantee it had before asking.
    return null
  }
}

/**
 * True when `pid` still names the process that wrote a record at
 * `recordedAtMs`. False proves the PID was recycled, so the writer is gone.
 *
 * Unknowns resolve to true on purpose. Wrongly reporting a live writer as
 * retired lets a second process claim a file the first is still writing, which
 * corrupts data; wrongly reporting a retired writer as live only refuses an
 * action, which the caller can surface.
 */
export function processIsLiveSince(pid, recordedAtMs, options = {}) {
  if (!processIsAlive(pid)) return false
  if (!Number.isFinite(recordedAtMs)) return true
  const startedAtMs = processStartTimeMs(pid, options.now ?? Date.now())
  if (startedAtMs === null) return true
  const toleranceMs = Number.isFinite(options.toleranceMs)
    ? options.toleranceMs
    : PROCESS_IDENTITY_TOLERANCE_MS
  return startedAtMs <= recordedAtMs + toleranceMs
}

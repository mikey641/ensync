import { runProcess } from './command.mjs'

// Warp Oz exposes the signed-in account through one non-consuming command:
//   $ oz whoami --output-format json
//   {"uid":"…","type":"user","display_name":"Mikey Hasson","email":"mikey641@gmail.com"}
// Verified against oz on macOS. `whoami` never talks to a model and reports no
// plan credits or reset schedule, so Ensync uses it only as the account proof
// and keeps the quota card honest ("unavailable").
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

function safeLogin(value) {
  if (typeof value !== 'string') return null
  const login = value.trim()
  if (!login || login.length > 160 || /[\u0000-\u001f\u007f]/.test(login)) return null
  return login
}

export function parseOzWhoami(result, checkedAt = new Date().toISOString()) {
  if (!result || result.timedOut || result.error) {
    return unavailable(
      result?.timedOut ? 'Oz whoami timed out.' : 'Oz whoami could not be started.',
      checkedAt,
    )
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')

  let parsed = null
  try {
    parsed = JSON.parse(output)
  } catch {
    // Non-JSON output is handled by the text fallback below.
  }
  const login = safeLogin(parsed?.email)
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && login) {
    return {
      state: 'authenticated',
      method: 'Warp account login',
      accountLogin: login,
      reason: 'Oz whoami returned the signed-in account.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }

  const lower = output.toLowerCase()
  if (lower.includes('not logged in') || lower.includes('not authenticated') || lower.includes('login required')) {
    return {
      state: 'not_authenticated',
      method: null,
      accountLogin: null,
      reason: 'Oz reports that it is not logged in.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }
  return unavailable('Oz returned no recognized whoami status.', checkedAt)
}

export async function probeOzWhoami(executable, checkedAt = new Date().toISOString(), options = {}) {
  const run = options.runProcess ?? runProcess
  const result = await run(executable, ['whoami', '--output-format', 'json'], {
    timeoutMs: options.timeoutMs ?? 8_000,
  })
  return parseOzWhoami(result, checkedAt)
}

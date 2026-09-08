import { runProcess } from './command.mjs'

// Qoder exposes account identity through one non-consuming command:
//   $ qodercli status -o json
//   {
//     "logged_in": true,
//     "version": "1.1.16",
//     "allow_byok": 0,
//     "username": "Mikey Hasson",
//     "email": "mikey641@gmail.com",
//     "avatar_url": "https://qoder.com/users/..."
//   }
// Verified against qodercli 1.1.16 on macOS. `status` never talks to a model
// and reports no credit percentage or reset schedule, so Ensync uses it only
// as the account proof and keeps the quota card honest ("unavailable").
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

export function parseQoderStatus(result, checkedAt = new Date().toISOString()) {
  if (!result || result.timedOut || result.error) {
    return unavailable(
      result?.timedOut ? 'Qoder status timed out.' : 'Qoder status could not be started.',
      checkedAt,
    )
  }
  let parsed = null
  try {
    parsed = JSON.parse([result.stdout, result.stderr].filter(Boolean).join('\n'))
  } catch {
    // Non-JSON output is not status proof.
  }
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    if (parsed.logged_in === false) {
      return {
        state: 'not_authenticated',
        method: null,
        accountLogin: null,
        reason: 'Qoder CLI reports that it is not logged in.',
        source: 'cli',
        checkedAt,
        exactPlan: null,
      }
    }
    const login = safeLogin(parsed.email)
    if (parsed.logged_in === true && login) {
      return {
        state: 'authenticated',
        method: 'Qoder account login',
        accountLogin: login,
        reason: 'Qoder CLI status returned the signed-in account.',
        source: 'cli',
        checkedAt,
        exactPlan: null,
      }
    }
  }
  return unavailable('Qoder CLI returned no recognized status.', checkedAt)
}

export async function probeQoderStatus(executable, checkedAt = new Date().toISOString(), options = {}) {
  const run = options.runProcess ?? runProcess
  const result = await run(executable, ['status', '-o', 'json'], {
    timeoutMs: options.timeoutMs ?? 8_000,
  })
  return parseQoderStatus(result, checkedAt)
}

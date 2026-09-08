import { runProcess } from './command.mjs'

// Amp exposes its account and balance through a single non-consuming command:
//   $ amp usage
//   Signed in as mikey641@gmail.com
//   Individual credits: $0 remaining - https://ampcode.com/settings
// Verified against amp 0.0.1786006377-g6eaed7 on macOS. The balance is a raw
// dollar amount with no included-allowance denominator or reset, so Ensync
// surfaces it as a detail and never derives a percentage from it.
const SIGNED_IN_PATTERN = /^Signed in as\s+(\S[^\r\n]*?)\s*$/m
const CREDITS_PATTERN = /Individual credits:\s*\$([0-9][0-9,]*)\s+remaining/i

function safeLogin(value) {
  if (typeof value !== 'string') return null
  const login = value.trim()
  if (!login || login.length > 120 || /[\u0000-\u001f\u007f]/.test(login)) return null
  return login
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
 * Parses one `amp usage` capture into both the account authentication result
 * and the optional credit-balance usage detail. A missing "Signed in as" line
 * degrades to unavailable rather than guessing; the signed-out message is not
 * pinned because Amp's logged-out text has not been captured on a signed-out
 * machine.
 */
export function parseAmpAccount(result, checkedAt = new Date().toISOString()) {
  if (!result || result.timedOut || result.error) {
    return {
      authentication: unavailable('Amp usage timed out or could not be started.', checkedAt),
      usage: null,
    }
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  const loginMatch = output.match(SIGNED_IN_PATTERN)
  if (!loginMatch) {
    return {
      authentication: unavailable(
        'Amp usage did not report a signed-in account, so the account check could not be confirmed.',
        checkedAt,
      ),
      usage: null,
    }
  }

  const creditsMatch = output.match(CREDITS_PATTERN)
  return {
    authentication: {
      state: 'authenticated',
      method: 'Amp account login',
      accountLogin: safeLogin(loginMatch[1]),
      reason: 'Amp usage reported the signed-in account.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    },
    usage: creditsMatch
      ? {
          availability: 'unavailable',
          source: 'cli',
          kind: 'subscription_quota',
          plan: null,
          model: null,
          usedPercent: null,
          remainingPercent: null,
          resetAt: null,
          checkedAt,
          details: [{ label: 'Individual credits', value: `$${creditsMatch[1]} remaining` }],
          reason: 'Amp usage reported the individual credit balance but no included-allowance total or reset schedule, so Ensync shows the balance without a percentage.',
        }
      : null,
  }
}

export async function probeAmpAccount(executable, checkedAt = new Date().toISOString(), options = {}) {
  const run = options.runProcess ?? runProcess
  const result = await run(executable, ['usage'], { timeoutMs: options.timeoutMs ?? 8_000 })
  return parseAmpAccount(result, checkedAt)
}

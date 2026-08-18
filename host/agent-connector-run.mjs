/**
 * Executes one connector turn on one provider, and walks Ensync's fallback
 * sequence when — and only when — the failure carries the same Host proof the
 * app requires before replaying a task somewhere else.
 *
 * Every classification here is Ensync's existing one: `parseCodexChatResult`,
 * `parseClaudeChatResult`, `quotaFailureIsSafe`, `claudeStartupFailureIsSafe`,
 * `DroidExecRunner`, and `safeFallbackProof`. Nothing about "did this fail?" or
 * "may this be retried elsewhere?" is re-decided for outside callers, because a
 * looser rule here would replay work a provider had already half-done on a
 * machine nobody is watching.
 */
import {
  ChatRunError,
  claudeStartupFailureIsSafe,
  parseClaudeChatResult,
  parseCodexChatResult,
  quotaFailureIsSafe,
} from './chat.mjs'
import { describeProcessExit, runProcess, subscriptionEnvironment } from './command.mjs'
import { DroidExecError, DroidExecRunner } from './droid-exec.mjs'
import { appendFallbackReason, safeFallbackProof } from './safe-fallback.mjs'

const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_CONNECTOR_OUTPUT_BYTES = 8 * 1024 * 1024

function timeoutMessage(name, reason) {
  return reason === 'inactivity'
    ? `${name} produced no output for the connector inactivity limit and was stopped. Partial work may exist.`
    : `${name} exceeded the connector run limit and was stopped. Partial work may exist.`
}

async function runSpawnedAttempt(candidate, options) {
  const { invocation } = candidate
  const result = await (options.processRunner ?? runProcess)(invocation.executable, invocation.args, {
    cwd: invocation.cwd ?? options.cwd,
    env: options.env ?? subscriptionEnvironment(),
    input: options.prompt,
    inactivityTimeoutMs: options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
    hardTimeoutMs: options.hardTimeoutMs ?? null,
    maxCaptureBytes: MAX_CONNECTOR_OUTPUT_BYTES,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    signal: options.signal,
  })

  if (result.aborted || options.signal?.aborted) {
    throw new ChatRunError('run_cancelled', `${candidate.name} was cancelled.`, 499, false)
  }
  if (result.timedOut) {
    throw new ChatRunError('run_timed_out', timeoutMessage(candidate.name, result.timeoutReason), 504, false)
  }
  if (result.error) {
    // Nothing ran, so another provider may safely take the same task.
    throw new ChatRunError('run_start_failed', `${candidate.name} could not be started: ${result.error}`, 502, true)
  }

  const outputTruncated = result.truncation?.stdout ?? (result.outputTruncated ? true : null)
  if (result.exitCode !== 0) {
    if (quotaFailureIsSafe(candidate.id, result.stdout, result.stderr, { outputTruncated })) {
      throw new ChatRunError(
        'provider_quota',
        `${candidate.name} reported a quota, rate-limit, or capacity failure before any tool activity.`,
        429,
        true,
      )
    }
    if (candidate.id === 'claude' && claudeStartupFailureIsSafe(result.stdout, result.stderr, result.outputTruncated)) {
      throw new ChatRunError(
        'provider_startup_failed',
        'Claude Code stopped during startup before any assistant or tool activity.',
        502,
        true,
      )
    }
    const output = result.stderr || result.stdout
    throw new ChatRunError(
      'cli_failed',
      `${describeProcessExit(candidate.name, result)}.${output ? ` ${output.slice(0, 500)}` : ''}`,
      502,
      false,
    )
  }

  const parsed = invocation.resultFormat === 'codex-json'
    ? parseCodexChatResult(result.stdout, { outputTruncated })
    : parseClaudeChatResult(result.stdout, { outputTruncated })
  return { response: parsed.response, model: parsed.model, usage: parsed.usage, sessionId: parsed.sessionId ?? null }
}

async function runDroidAttempt(candidate, options) {
  const runner = options.droidRunner ?? new DroidExecRunner()
  try {
    const result = await runner.run({
      // A connector run has no retained job to carry a question back to, so it
      // must never open Droid's questionnaire channel: `id: null` is what keeps
      // an unanswerable prompt from pinning an unattended run.
      id: null,
      executable: candidate.invocation.executable,
      projectPath: candidate.invocation.projectPath,
      prompt: options.prompt,
      attachmentPaths: [],
      sessionId: null,
      model: null,
      effort: candidate.invocation.effort ?? null,
      env: options.env ?? subscriptionEnvironment(),
    }, { signal: options.signal })
    return { response: result.response, model: result.model ?? null, usage: result.usage ?? null, sessionId: null }
  } catch (error) {
    if (error instanceof DroidExecError) {
      throw new ChatRunError(error.code, error.message, error.status, error.safeToRetry)
    }
    throw error
  }
}

/** One turn on one provider. Throws ChatRunError, carrying Ensync's own codes. */
export async function runConnectorAttempt(candidate, options = {}) {
  if (typeof options.prompt !== 'string' || !options.prompt.trim()) {
    throw new ChatRunError('invalid_request', 'A connector run needs a prompt.', 400, false)
  }
  const startedAt = Date.now()
  const result = candidate.invocation.kind === 'droid-runner'
    ? await runDroidAttempt(candidate, options)
    : await runSpawnedAttempt(candidate, options)
  return {
    provider: candidate.id,
    providerName: candidate.name,
    containment: candidate.invocation.containment,
    durationMs: Date.now() - startedAt,
    ...result,
  }
}

/**
 * Walks a plan's fallback sequence. A provider is only handed the task after a
 * failure that `safeFallbackProof` accepts — a verified quota failure with zero
 * observed activity, or a preflight failure before execution. Any other failure
 * ends the run with that provider's error, because partial work may exist.
 *
 * `refreshPlan` (optional) re-asks the Host for a plan with the attempted
 * providers excluded, so a long run picks up usage that changed while it ran —
 * the same reason the app refreshes providers before every fallback hop.
 */
export async function runConnectorPlan(plan, options = {}) {
  const attempts = []
  let fallbackReason = null
  let sequence = plan.sequence
  let index = 0

  if (sequence.length === 0) {
    throw new ChatRunError(
      'provider_unavailable',
      'Ensync routing has no connected provider with remaining subscription capacity for this request.',
      503,
      false,
    )
  }

  for (;;) {
    const candidate = sequence[index]
    if (!candidate) {
      const last = attempts.at(-1)
      throw new ChatRunError(
        last?.code ?? 'provider_unavailable',
        `Every provider Ensync routing offered failed. ${last?.message ?? ''}`.trim(),
        last?.status ?? 503,
        false,
      )
    }
    try {
      const result = await runConnectorAttempt(candidate, options)
      return { ...result, attempts, fallbackReason }
    } catch (error) {
      if (!(error instanceof ChatRunError)) throw error
      attempts.push({ provider: candidate.id, code: error.code, message: error.message, status: error.status })
      const proof = options.fallbackEnabled === false ? null : safeFallbackProof(error)
      if (!proof) throw error

      const attemptedIds = attempts.map((attempt) => attempt.provider)
      if (typeof options.refreshPlan === 'function') {
        const refreshed = await options.refreshPlan(attemptedIds)
        if (refreshed?.sequence?.length) {
          sequence = refreshed.sequence
          index = 0
        } else {
          sequence = []
          index = 0
        }
      } else {
        sequence = sequence.filter((entry) => !attemptedIds.includes(entry.id))
        index = 0
      }
      const next = sequence[0]
      if (!next) throw error
      fallbackReason = appendFallbackReason(
        fallbackReason,
        proof.kind === 'quota'
          ? `${candidate.name} reported a Host-verified quota failure with zero observed activity; continuing with ${next.name}.`
          : `${candidate.name} failed Host preflight before execution; continuing with ${next.name}.`,
      )
      options.onFallback?.({ from: candidate.id, to: next.id, kind: proof.kind, code: error.code })
    }
  }
}

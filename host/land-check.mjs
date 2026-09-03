import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from './command.mjs'

export const LAND_CHECK_SCRIPT = 'land:check'
export const LAND_QUICK_CHECK_SCRIPT = 'land:quick'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000
const DEFAULT_QUICK_TIMEOUT_MS = 60_000
const OUTPUT_TAIL_CHARACTERS = 4_000
const MAX_CHECK_OUTPUT_BYTES = 256 * 1024

function outputTail(result) {
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  return combined.length > OUTPUT_TAIL_CHARACTERS ? combined.slice(-OUTPUT_TAIL_CHARACTERS) : combined
}

/**
 * Runs the repository's own land gate (`npm run land:check`) so a merge into
 * the baseline is verified semantically, not just textually — a textually
 * clean merge can still drop declarations whose usages survive. Repositories
 * without the script keep their current behavior (the check is skipped), and
 * infrastructure problems — npm missing, the check never finishing — also
 * skip rather than block automatic landing. Only a check that ran to
 * completion and failed reports ok: false.
 */
export async function runLandCheck(repositoryPath, options = {}) {
  return runRepositoryCheck(repositoryPath, LAND_CHECK_SCRIPT, {
    ...options,
    failClosedOnInfrastructure: false,
    retryOnFailure: options.retryOnFailure !== false,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
}

/**
 * Optional fast gate used by automatic landing trains. Unlike the historical
 * full gate, an explicitly configured quick check fails closed when its
 * executable disappears or times out; configured verification is never
 * silently bypassed.
 */
export async function runLandQuickCheck(repositoryPath, options = {}) {
  return runRepositoryCheck(repositoryPath, LAND_QUICK_CHECK_SCRIPT, {
    ...options,
    failClosedOnInfrastructure: true,
    retryOnFailure: false,
    timeoutMs: options.timeoutMs ?? DEFAULT_QUICK_TIMEOUT_MS,
  })
}

async function runRepositoryCheck(repositoryPath, scriptName, options) {
  let scripts
  try {
    scripts = JSON.parse(await readFile(join(repositoryPath, 'package.json'), 'utf8'))?.scripts
  } catch {
    return { ok: true, skipped: true, reason: `This repository has no readable package.json, so there is no ${scriptName} check to run.` }
  }
  if (typeof scripts?.[scriptName] !== 'string' || !scripts[scriptName].trim()) {
    return { ok: true, skipped: true, reason: `This repository defines no ${scriptName} script, so there is no check to run.` }
  }

  const run = options.processRunner ?? runProcess
  const timeoutMs = options.timeoutMs
  const invoke = () => run(options.npmExecutable ?? 'npm', ['run', scriptName], {
    cwd: repositoryPath,
    env: options.environment ?? process.env,
    inactivityTimeoutMs: timeoutMs,
    hardTimeoutMs: timeoutMs,
    maxCaptureBytes: MAX_CHECK_OUTPUT_BYTES,
    signal: options.signal,
  })

  let result = await invoke()
  // Suites with timing-sensitive tests can fail under the load of concurrent
  // agent runs. A flaky red would roll back a good merge, so a failure is
  // confirmed by a second run; a genuine break fails both times.
  if (!result.error && !result.timedOut && result.exitCode !== 0 && options.retryOnFailure) {
    result = await invoke()
  }

  if (result.error) {
    const failure = { reason: `npm could not run the ${scriptName} script (${result.error}), so the land was not verified.` }
    return options.failClosedOnInfrastructure ? { ok: false, ...failure } : { ok: true, skipped: true, ...failure }
  }
  if (result.timedOut) {
    const failure = { reason: `The ${scriptName} script did not finish within its time limit, so the land was not verified.` }
    return options.failClosedOnInfrastructure ? { ok: false, ...failure } : { ok: true, skipped: true, ...failure }
  }
  if (result.exitCode === 0) return { ok: true }
  return {
    ok: false,
    reason: `The repository's ${scriptName} script failed (exit ${result.exitCode}).`,
    output: outputTail(result),
  }
}

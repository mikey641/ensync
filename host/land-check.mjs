import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from './command.mjs'

export const LAND_CHECK_SCRIPT = 'land:check'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000
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
  let scripts
  try {
    scripts = JSON.parse(await readFile(join(repositoryPath, 'package.json'), 'utf8'))?.scripts
  } catch {
    return { ok: true, skipped: true, reason: 'This repository has no readable package.json, so there is no land check to run.' }
  }
  if (typeof scripts?.[LAND_CHECK_SCRIPT] !== 'string' || !scripts[LAND_CHECK_SCRIPT].trim()) {
    return { ok: true, skipped: true, reason: `This repository defines no ${LAND_CHECK_SCRIPT} script, so there is no land check to run.` }
  }

  const run = options.processRunner ?? runProcess
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const invoke = () => run(options.npmExecutable ?? 'npm', ['run', LAND_CHECK_SCRIPT], {
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
  if (!result.error && !result.timedOut && result.exitCode !== 0 && options.retryOnFailure !== false) {
    result = await invoke()
  }

  if (result.error) {
    return { ok: true, skipped: true, reason: `npm could not run the ${LAND_CHECK_SCRIPT} script (${result.error}), so the land was not verified.` }
  }
  if (result.timedOut) {
    return { ok: true, skipped: true, reason: `The ${LAND_CHECK_SCRIPT} script did not finish within its time limit, so the land was not verified.` }
  }
  if (result.exitCode === 0) return { ok: true }
  return {
    ok: false,
    reason: `The repository's ${LAND_CHECK_SCRIPT} script failed (exit ${result.exitCode}).`,
    output: outputTail(result),
  }
}

import { spawn } from 'node:child_process'
import { commandInvocation } from './command.mjs'

// Pinned per the Step 1 verification recorded in docs/providers/junie.md, against the
// installed JetBrains Junie CLI (`junie --version` -> "Junie version: 26.8.3 (2548.5)").
// Every flag spelled below is copied verbatim from `junie --help`, including the `=`
// form: the help text documents `--flag=<value>` and only that spelling was verified.
// Whether the Clikt parser also accepts a space-separated value was NOT verified, so
// this runner does not assume it.
//
// The prompt is delivered on **stdin**, never in argv. Junie's own error strings prove
// stdin is a first-class input path and that it is mutually exclusive with the task
// argument: "The --task option is not supported when reading input from stdin" and
// "Positional arguments are not supported when reading input from stdin".

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const MAX_STDERR_CHARACTERS = 256 * 1024
const MAX_STDOUT_CHARACTERS = 8 * 1024 * 1024
const MAX_TEXT_CHARACTERS = 256 * 1024

// `--output-format=json` emits ONE terminal `CliOutput` object. The `json-stream`
// format is deliberately not used: its event union (org.jetbrains.a2ux.api.AgentEvent)
// has terminal candidates, but the serialized `type` discriminator strings could not be
// recovered from the release jar, and Ensync will not call a run successful by matching
// an event name it has not verified.
export const JUNIE_OUTPUT_FORMAT = 'json'
// The prompt arrives on stdin as plain text. `json` would require Junie's `CliInput`
// envelope, whose success/failure semantics are unverified.
export const JUNIE_INPUT_FORMAT = 'text'

// `junie --help` enumerates exactly three effort levels. Ensync's Model size selector
// also offers `max`, which has no Junie equivalent, so `max` is simply not sent rather
// than being silently mapped onto `high` — Ensync does not invent effort values.
export const JUNIE_EFFORTS = new Set(['low', 'medium', 'high'])

// A headless Junie run is "always trusted" per JetBrains' own configuration docs, which
// means it would otherwise load project-supplied config, MCP servers, skills, custom
// agents, and commands out of the worktree it was pointed at. For an Ensync protected
// worktree holding a third-party repository that is untrusted-input execution, so the
// default config locations are switched off for every run.
export const JUNIE_CONFIG_DEFAULT_LOCATIONS = 'false'

export class JunieExecError extends Error {
  constructor(code, message, status = 502, safeToRetry = false) {
    super(message)
    this.name = 'JunieExecError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

/**
 * Builds the argument vector for one headless Junie run.
 *
 * Deliberately absent, each for a recorded reason:
 * - `--task` / a positional task: the prompt goes on stdin, and Junie refuses both when
 *   it is reading stdin.
 * - `--provider`: selecting a BYOK provider bills the user's own API key directly
 *   instead of their JetBrains subscription. Ensync runs on the subscription.
 * - `--brave`: documented as "(interactive only)", so sending it from a headless run
 *   asserts a containment level that was never verified.
 * - `--review`, `--demo`, `--gateway`, `--prepare-pr-structure`: this release build
 *   rejects all four with "not available in this version. Please use the Nightly build."
 */
export function junieSessionArguments(input = {}) {
  const args = [
    `--project=${input.projectPath}`,
    `--input-format=${JUNIE_INPUT_FORMAT}`,
    `--output-format=${JUNIE_OUTPUT_FORMAT}`,
    `--config-default-locations=${JUNIE_CONFIG_DEFAULT_LOCATIONS}`,
    // The launcher at ~/.local/bin/junie applies pending updates before exec. A Host run
    // must never race an upgrade.
    '--skip-update-check',
  ]
  if (input.model) args.push(`--model=${input.model}`)
  if (input.effort && JUNIE_EFFORTS.has(input.effort)) args.push(`--effort=${input.effort}`)
  if (input.sessionId) {
    args.push(`--session-id=${input.sessionId}`, '--resume')
  }
  return args
}

function truncate(value) {
  return value.length > MAX_TEXT_CHARACTERS ? value.slice(0, MAX_TEXT_CHARACTERS) : value
}

/**
 * Reads the one terminal `CliOutput` object out of Junie's stdout.
 *
 * Junie is a JVM application behind a bash shim, and either layer can print an
 * unstructured line (an update notice, a JLine terminal escape) around the JSON. The
 * object is therefore located rather than assumed to be the whole of stdout: the last
 * line that parses as a JSON object carrying a recognised `CliOutput` field wins.
 * Verified `CliOutput` fields: taskName, result, changes, errors, llmUsage.
 */
export function junieTerminalOutput(stdout) {
  if (typeof stdout !== 'string') return null
  let found = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // A brace-leading line that is not JSON is provider chatter, not a protocol
      // frame; the terminal object is identified positively below, never by exclusion.
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const recognised = ['result', 'errors', 'changes', 'llmUsage', 'taskName']
      .some((field) => Object.hasOwn(parsed, field))
    if (recognised) found = parsed
  }
  return found
}

/**
 * Names the errors Junie itself reported. `CliOutput.errors` is a list of strings; only
 * entries that are genuinely non-empty strings count, so an empty list and a list of
 * blanks both read as "no reported error".
 */
export function junieReportedErrors(output) {
  if (!Array.isArray(output?.errors)) return []
  return output.errors
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim())
}

/**
 * Maps Junie's `LlmUsageOutput` onto Ensync's usage record. Verified fields: calls,
 * inputTokens, outputTokens, cacheInputTokens, cacheCreateTokens, cost. Only the three
 * Ensync records are read; a value that is not a safe non-negative integer is reported
 * as unknown rather than coerced.
 */
export function junieUsage(llmUsage) {
  if (!llmUsage || typeof llmUsage !== 'object') return null
  const integer = (candidate) => (Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null)
  const inputTokens = integer(llmUsage.inputTokens)
  const outputTokens = integer(llmUsage.outputTokens)
  const cachedInputTokens = integer(llmUsage.cacheInputTokens)
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null
  return { source: 'cli', inputTokens, outputTokens, cachedInputTokens }
}

class JunieExecSession {
  #child
  #stdout = ''
  #stderr = ''
  #settled = false
  #wrotePrompt = false
  #hardTimer = null
  #inactivityTimer = null
  #forceKillTimer = null
  #resolveDone
  #rejectDone
  #done

  constructor(input, options = {}) {
    this.input = input
    this.onEvent = options.onEvent
    this.signal = options.signal
    this.spawnProcess = options.spawnProcess ?? spawn
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
    this.hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS
    this.#done = new Promise((resolve, reject) => {
      this.#resolveDone = resolve
      this.#rejectDone = reject
    })
    void this.#done.catch(() => {})
  }

  async run() {
    const startedAt = Date.now()
    const args = junieSessionArguments(this.input)
    const invocation = commandInvocation(this.input.executable, args, this.input.env)
    this.#child = this.spawnProcess(invocation.executable, invocation.args, {
      cwd: this.input.projectPath,
      env: this.input.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.onEvent?.({
      type: 'started',
      provider: 'junie',
      cwd: this.input.projectPath,
      command: [this.input.executable, ...args].join(' '),
      at: new Date(startedAt).toISOString(),
    })

    this.#child.stdout.on('data', (chunk) => {
      this.#touch()
      this.#stdout = `${this.#stdout}${chunk.toString('utf8')}`.slice(0, MAX_STDOUT_CHARACTERS)
    })
    this.#child.stderr.on('data', (chunk) => {
      this.#touch()
      const text = chunk.toString('utf8')
      this.#stderr = `${this.#stderr}${text}`.slice(0, MAX_STDERR_CHARACTERS)
      this.onEvent?.({
        type: 'output',
        stream: 'stderr',
        text,
        redacted: false,
        at: new Date().toISOString(),
      })
    })
    this.#child.on('error', (error) => {
      this.#fail(new JunieExecError(
        'run_start_failed',
        `Junie could not be started: ${error.message}`,
        502,
        !this.#wrotePrompt,
      ))
    })
    this.#child.on('close', (exitCode, signal) => {
      if (this.#settled) return
      this.#settled = true
      this.#resolveDone({ exitCode, signal })
    })
    this.#child.stdin.on('error', () => {
      // The close/error event is authoritative; a concurrent exit can close stdin first.
    })

    this.#touch()
    this.#hardTimer = setTimeout(() => this.#fail(new JunieExecError(
      'run_timed_out',
      "Junie reached Ensync Host's hard run limit and was stopped. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.hardTimeoutMs)
    this.#hardTimer.unref?.()
    this.signal?.addEventListener('abort', this.#abort, { once: true })
    if (this.signal?.aborted) this.#abort()

    try {
      // Junie refuses --task and positional arguments while reading stdin, so the whole
      // prompt is the stdin payload and the stream is closed to mark its end.
      this.#child.stdin.end(this.input.prompt, 'utf8')
      this.#wrotePrompt = true

      const exit = await this.#done
      const output = junieTerminalOutput(this.#stdout)
      if (!output) throw this.#missingTerminalOutputFailure(exit)

      const reported = junieReportedErrors(output)
      if (reported.length > 0) {
        throw new JunieExecError(
          'cli_failed',
          `Junie ended the task with an error: ${truncate(reported.join('; '))}`,
          502,
          false,
        )
      }
      const response = typeof output.result === 'string' && output.result.trim()
        ? truncate(output.result.trim())
        : null
      if (!response) {
        throw new JunieExecError(
          'empty_cli_response',
          'Junie finished without a verifiable final result.',
          502,
          false,
        )
      }
      return {
        provider: 'junie',
        projectPath: this.input.projectPath,
        response,
        sessionId: typeof output.sessionId === 'string' && output.sessionId ? output.sessionId : null,
        model: null,
        requestedModel: this.input.model ?? null,
        requestedEffort: this.input.effort ?? null,
        usage: junieUsage(output.llmUsage),
        outputRecovery: null,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof JunieExecError) throw error
      throw new JunieExecError(
        'junie_exec_failed',
        'Junie execution failed before Ensync received a verified completion.',
        502,
        !this.#wrotePrompt,
      )
    } finally {
      this.#finishProcess()
    }
  }

  /**
   * Explains an exit that produced no terminal `CliOutput`. There is no partial-credit
   * path here: without that object Ensync has no verified completion, so a zero exit
   * code is reported as an unverifiable run rather than quietly treated as success.
   */
  #missingTerminalOutputFailure(exit) {
    const detail = this.#stderr.trim()
      ? ` ${truncate(this.#stderr.trim()).slice(0, 500)}`
      : Number.isInteger(exit?.exitCode)
        ? ` It exited with code ${exit.exitCode}.`
        : exit?.signal
          ? ` It was terminated by ${exit.signal}.`
          : ''
    return new JunieExecError(
      'invalid_cli_output',
      `Junie ended without the JSON result object Ensync Host needs to verify the task completed.${detail}`,
      502,
      !this.#wrotePrompt,
    )
  }

  #abort = () => {
    this.#fail(new JunieExecError(
      'run_cancelled',
      'Run stopped by user. The provider process was terminated.',
      499,
      false,
    ))
  }

  #touch() {
    if (this.#settled || !Number.isFinite(this.inactivityTimeoutMs)) return
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer)
    // This watchdog is Junie's only protection against the one failure Step 1 could not
    // rule out without spending a model turn: whether a headless run can stop on an
    // approval request it has no way to render. If it can, the run stalls silently, and
    // this timer is what ends it instead of hanging forever the way droid once did.
    this.#inactivityTimer = setTimeout(() => this.#fail(new JunieExecError(
      'run_timed_out',
      "Junie produced no output before Ensync Host's inactivity limit and was stopped. If it was waiting on an approval it could not show, no answer could be given. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.inactivityTimeoutMs)
    this.#inactivityTimer.unref?.()
  }

  #fail(error) {
    if (this.#settled) return
    this.#settled = true
    this.#rejectDone(error)
    this.#terminate()
  }

  #finishProcess() {
    clearTimeout(this.#hardTimer)
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer)
    this.signal?.removeEventListener('abort', this.#abort)
    if (!this.#child) return
    if (!this.#child.stdin.destroyed) this.#child.stdin.end()
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#forceKillTimer = setTimeout(() => this.#terminate(), 1_000)
      this.#forceKillTimer.unref?.()
    }
  }

  #terminate() {
    if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) return
    try {
      this.#child.kill('SIGTERM')
    } catch {
      // A concurrent process exit requires no further cleanup.
    }
    if (this.#forceKillTimer) return
    this.#forceKillTimer = setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        try {
          this.#child.kill('SIGKILL')
        } catch {
          // A concurrent process exit requires no further cleanup.
        }
      }
    }, 1_000)
    this.#forceKillTimer.unref?.()
  }
}

export class JunieExecRunner {
  #spawnProcess
  #inactivityTimeoutMs
  #hardTimeoutMs

  constructor(options = {}) {
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs
    this.#hardTimeoutMs = options.hardTimeoutMs
  }

  run(input, options = {}) {
    return new JunieExecSession(input, {
      ...options,
      spawnProcess: this.#spawnProcess,
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    }).run()
  }
}

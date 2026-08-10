import { spawn } from 'node:child_process'
import { commandInvocation } from './command.mjs'

// Pinned per the Step 1 verification recorded in docs/providers/auggie.md, against the
// installed Augment Auggie CLI (`auggie --version` -> "0.34.0 (commit 81042879)").
//
// Auggie ships as a readable ESM bundle at
// /opt/homebrew/lib/node_modules/@augmentcode/auggie/augment.mjs, so every constant
// below was read out of the CLI's own option table, permission engine, and JSON
// reporter rather than guessed. No instruction was ever sent to a model.

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const MAX_STDERR_CHARACTERS = 256 * 1024
const MAX_STDOUT_CHARACTERS = 8 * 1024 * 1024
const MAX_TEXT_CHARACTERS = 256 * 1024

// `--output-format` accepts exactly "text" (default) and "json", and only alongside
// `--print`. `json` suppresses every per-chunk and per-tool console write and emits ONE
// terminal object, which is what Ensync verifies a completed turn against.
export const AUGGIE_OUTPUT_FORMAT = 'json'

// The prompt travels on stdin, never in argv. Auggie's own config assembly reads stdin
// whenever `output.mode === "text"`, and `output.mode` is "text" for ANY `--print` run —
// it is a separate field from `output.format`, so `--print --output-format json` still
// reads stdin. See docs/providers/auggie.md for the exact source excerpt.
export const AUGGIE_PROMPT_TRANSPORT = 'stdin'

// Auggie's stdin reader gives up if the FIRST chunk has not arrived within 100 ms:
//   let r = setTimeout(() => { n || (i(), t(null)) }, 100)
// So the prompt must be written in the same turn of the event loop as the spawn, before
// any await. This constant exists to document the deadline the runner is racing.
export const AUGGIE_STDIN_FIRST_CHUNK_DEADLINE_MS = 100

// The tools Ensync refuses to let a chat run use, denied by name. Names are verbatim
// from `auggie tools list`, which runs offline and needs no account. Everything absent
// from this list stays enabled, because Auggie's default with NO rules is allow-all
// (`b2e`: `if (o.length === 0) return { allow: true }`) and a task that cannot edit
// files is not a task Ensync was asked to run.
//
// `web-fetch` is denied because an Ensync protected worktree can hold a third-party
// repository, and a fetch tool turns repository content into an outbound request.
// The process tools are denied because Auggie's `--permission` string form cannot
// express `shellInputRegex` — that field exists only in the settings.json rule schema —
// so a shell can be allowed entirely or denied entirely, and "entirely" is the only
// honest choice for an unattended run.
export const AUGGIE_DENIED_TOOLS = Object.freeze([
  'launch-process',
  'read-process',
  'write-process',
  'kill-process',
  'list-processes',
  'web-fetch',
])

// Verified `subtype` values, from the CLI's own reporter. `success` is the initial state
// and the only one that survives a clean run; the other three are each set by exactly
// one handler (onError, onMaxIterationsExceeded, onEmptyCompletion).
const TURN_SUBTYPE_SUCCESS = 'success'
const TURN_SUBTYPE_MAX_TURNS = 'error_max_turns'
const TURN_SUBTYPE_EMPTY = 'empty_completion'

// Auggie drops a `--permission` rule it cannot parse instead of refusing to start
// (`AYo` catches and `console.warn`s). That warning line is the ONLY signal that a
// containment rule was not applied — there is no echo of the effective permission set —
// so the runner treats it as a hard containment failure.
const PERMISSION_PARSE_WARNING = 'Failed to parse permission rule'

export class AuggieExecError extends Error {
  constructor(code, message, status = 502, safeToRetry = false) {
    super(message)
    this.name = 'AuggieExecError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

/**
 * Builds the `--permission <tool-name>:<policy>` arguments for one run.
 *
 * Only `deny` is ever emitted. `allow` is redundant (no rule already means allow) and
 * `ask-user` is deliberately never sent: a `--print` run has no approval handler, so
 * `ask-user` resolves to the same denial but with a vaguer explanation to the model.
 */
export function auggiePermissionArguments(deniedTools = AUGGIE_DENIED_TOOLS) {
  return deniedTools.flatMap((tool) => ['--permission', `${tool}:deny`])
}

/**
 * Builds the argument vector for one headless Auggie run.
 *
 * Deliberately absent, each for a recorded reason:
 * - `-i/--instruction`, `-if/--instruction-file`, and the positional instruction: the
 *   prompt goes on stdin, and Ensync never puts a prompt in argv.
 * - `-q/--quiet`: it would suppress the JSON object as well as the chatter.
 * - `--show-cost`: it adds a billing block but is not needed to verify completion.
 * - `-a/--ask`: read-only mode cannot carry out an Ensync task.
 * - `--enhance-prompt`: it rewrites the caller's prompt before sending it.
 * - `-c/--continue` and a bare `-r/--resume`: both pick a session implicitly, and a bare
 *   `--resume` opens an interactive picker, which a headless run must never do.
 */
export function auggieSessionArguments(input = {}) {
  const args = [
    '--print',
    '--output-format', AUGGIE_OUTPUT_FORMAT,
    // Auggie otherwise auto-detects a git root that may sit ABOVE the protected
    // worktree. Pinning the workspace root keeps retrieval and indexing inside the
    // directory Ensync contained the run to.
    '--workspace-root', input.projectPath,
    // A protected worktree can hold a third-party repository, so nothing outside the
    // pinned root is discovered and indexed.
    '--no-discover-workspaces',
    // The terminal title belongs to whoever launched the Host, not to the provider.
    '--no-update-terminal-title',
    ...auggiePermissionArguments(input.deniedTools ?? AUGGIE_DENIED_TOOLS),
  ]
  if (input.model) args.push('--model', input.model)
  // No effort flag exists. Ensync's low/medium/high/max tiers have no Auggie equivalent,
  // so effort is dropped rather than mapped onto `--persona`, which means something else.
  if (input.sessionId) args.push('--resume', input.sessionId)
  if (Number.isSafeInteger(input.maxTurns) && input.maxTurns > 0) {
    args.push('--max-turns', String(input.maxTurns))
  }
  return args
}

function truncate(value) {
  return value.length > MAX_TEXT_CHARACTERS ? value.slice(0, MAX_TEXT_CHARACTERS) : value
}

/**
 * Reads the one terminal result object out of Auggie's stdout.
 *
 * The object is located rather than assumed to be the whole of stdout: unstructured
 * lines are printed on the same stream around it (observed live and unauthenticated:
 * "Warning: Could not fetch tenant MCP server configurations: ..."). The last line that
 * parses into an object with `type === "result"` wins.
 */
export function auggieTerminalResult(stdout) {
  if (typeof stdout !== 'string') return null
  let found = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // A brace-leading line that is not JSON is provider chatter, not a protocol frame;
      // the terminal object is identified positively below, never by exclusion.
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    if (parsed.type !== 'result') continue
    found = parsed
  }
  return found
}

/**
 * Reports whether Auggie warned that it dropped a `--permission` rule. The warning is
 * emitted by `console.warn`, and the bundle uses stdout and stderr helpers
 * inconsistently elsewhere, so both streams are searched.
 */
export function auggiePermissionRuleDropped(...streams) {
  return streams.some((stream) => typeof stream === 'string' && stream.includes(PERMISSION_PARSE_WARNING))
}

/**
 * Maps Auggie's `billing` block onto Ensync's usage record. The block only appears with
 * `--show-cost`, and it reports cost rather than tokens, so there is no token usage to
 * record and this returns null. It exists so the absence is deliberate and documented
 * rather than an oversight.
 */
export function auggieUsage() {
  return null
}

/**
 * Classifies a terminal result object that is not a clean success.
 *
 * `empty_completion` is the subtle one: Auggie sets `is_error: false` for it, so a naive
 * `is_error` check would treat a model that returned nothing as a completed turn.
 */
function turnFailure(result) {
  const subtype = typeof result?.subtype === 'string' ? result.subtype : 'unknown'
  if (subtype === TURN_SUBTYPE_EMPTY) {
    return new AuggieExecError(
      'empty_cli_response',
      'Augment Auggie reported that the model returned an empty response, so the turn produced no answer.',
      502,
      true,
    )
  }
  if (subtype === TURN_SUBTYPE_MAX_TURNS) {
    return new AuggieExecError(
      'cli_failed',
      'Augment Auggie stopped because the run reached its maximum number of agentic turns. Partial work may exist; review the project before retrying.',
      502,
      false,
    )
  }
  return new AuggieExecError(
    'cli_failed',
    `Augment Auggie ended the turn without a completed result (subtype: ${subtype}).`,
    502,
    false,
  )
}

class AuggieExecSession {
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
    const args = auggieSessionArguments(this.input)
    const invocation = commandInvocation(this.input.executable, args, this.input.env)
    this.#child = this.spawnProcess(invocation.executable, invocation.args, {
      cwd: this.input.projectPath,
      env: this.input.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    // The prompt is written BEFORE anything else, deliberately and synchronously.
    // Auggie abandons stdin if the first chunk has not landed within
    // AUGGIE_STDIN_FIRST_CHUNK_DEADLINE_MS, and it then runs with an EMPTY instruction
    // rather than failing — so a run that lost that race would look like a real turn.
    // Nothing awaitable may be introduced between the spawn and this write.
    this.#child.stdin.end(this.input.prompt, 'utf8')
    this.#wrotePrompt = true

    this.onEvent?.({
      type: 'started',
      provider: 'auggie',
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
      this.#fail(new AuggieExecError(
        'run_start_failed',
        `Augment Auggie could not be started: ${error.message}`,
        502,
        true,
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
    this.#hardTimer = setTimeout(() => this.#fail(new AuggieExecError(
      'run_timed_out',
      "Augment Auggie reached Ensync Host's hard run limit and was stopped. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.hardTimeoutMs)
    this.#hardTimer.unref?.()
    this.signal?.addEventListener('abort', this.#abort, { once: true })
    if (this.signal?.aborted) this.#abort()

    try {
      const exit = await this.#done

      // Checked before the result is read, so a run whose containment silently weakened
      // is never reported as a success on the strength of its answer.
      if (auggiePermissionRuleDropped(this.#stdout, this.#stderr)) {
        throw new AuggieExecError(
          'provider_containment_unverified',
          'Augment Auggie reported that it could not parse a tool-permission rule and dropped it, so this run was not contained the way Ensync asked. Review the project before retrying.',
          409,
          false,
        )
      }

      const result = auggieTerminalResult(this.#stdout)
      if (!result) throw this.#missingTerminalResultFailure(exit)
      if (result.is_error === true || result.subtype !== TURN_SUBTYPE_SUCCESS) {
        throw turnFailure(result)
      }

      const response = typeof result.result === 'string' && result.result.trim()
        ? truncate(result.result.trim())
        : null
      if (!response) {
        throw new AuggieExecError(
          'empty_cli_response',
          'Augment Auggie finished without a verifiable final assistant message.',
          502,
          false,
        )
      }
      return {
        provider: 'auggie',
        projectPath: this.input.projectPath,
        response,
        sessionId: typeof result.session_id === 'string' && result.session_id ? result.session_id : null,
        model: null,
        requestedModel: this.input.model ?? null,
        requestedEffort: this.input.effort ?? null,
        usage: auggieUsage(result.billing),
        outputRecovery: null,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof AuggieExecError) throw error
      throw new AuggieExecError(
        'auggie_exec_failed',
        'Augment Auggie execution failed before Ensync received a verified completion.',
        502,
        !this.#wrotePrompt,
      )
    } finally {
      this.#finishProcess()
    }
  }

  /**
   * Explains an exit that produced no terminal result object. There is no partial-credit
   * path: without that object Ensync has no verified completion, so a zero exit code is
   * reported as an unverifiable run rather than quietly treated as success.
   */
  #missingTerminalResultFailure(exit) {
    const detail = this.#stderr.trim()
      ? ` ${truncate(this.#stderr.trim()).slice(0, 500)}`
      : Number.isInteger(exit?.exitCode)
        ? ` It exited with code ${exit.exitCode}.`
        : exit?.signal
          ? ` It was terminated by ${exit.signal}.`
          : ''
    return new AuggieExecError(
      'invalid_cli_output',
      `Augment Auggie ended without the JSON result object Ensync Host needs to verify the turn completed.${detail}`,
      502,
      false,
    )
  }

  #abort = () => {
    this.#fail(new AuggieExecError(
      'run_cancelled',
      'Run stopped by user. The provider process was terminated.',
      499,
      false,
    ))
  }

  #touch() {
    if (this.#settled || !Number.isFinite(this.inactivityTimeoutMs)) return
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer)
    // Auggie's own code path denies an unapprovable tool and keeps going rather than
    // waiting on a person, but that was read from its source and never watched on a
    // signed-in run. This watchdog is what ends the run if that reading is ever wrong,
    // instead of hanging forever the way droid once did.
    this.#inactivityTimer = setTimeout(() => this.#fail(new AuggieExecError(
      'run_timed_out',
      "Augment Auggie produced no output before Ensync Host's inactivity limit and was stopped. If it was waiting on an approval it could not show, no answer could be given. Partial work may exist; review the project before retrying.",
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

export class AuggieExecRunner {
  #spawnProcess
  #inactivityTimeoutMs
  #hardTimeoutMs

  constructor(options = {}) {
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs
    this.#hardTimeoutMs = options.hardTimeoutMs
  }

  run(input, options = {}) {
    return new AuggieExecSession(input, {
      ...options,
      spawnProcess: this.#spawnProcess,
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    }).run()
  }
}

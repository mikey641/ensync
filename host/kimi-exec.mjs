import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { commandInvocation } from './command.mjs'

// Pinned per the Step 1 verification recorded in docs/providers/kimi.md, against the
// installed Kimi Code CLI (`kimi --version` -> 0.34.0). The binary ships its own
// JavaScript bundle in plaintext, and that source — not observed behaviour — is the
// authority for the permission ordering and the terminal event below. No prompt was
// ever sent to a model to establish any of it.

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const MAX_STDERR_CHARACTERS = 256 * 1024
const MAX_TEXT_CHARACTERS = 256 * 1024

// `kimi --help`: --output-format has choices(["text", "stream-json"]) and applies to
// prompt mode only. stream-json is NDJSON written by PromptJsonWriter.
export const KIMI_OUTPUT_FORMAT = 'stream-json'

// The single terminal frame. PromptJsonWriter emits no completion event of its own —
// `finish()` merely flushes the pending assistant message, and the agent bus's
// `turn.ended` has no case in dispatchNativeEvent so it never reaches stdout. What does
// prove completion is `writeResumeHint`, which the prompt-mode entry point calls only
// AFTER runNativeTurn returns; runNativeTurn returns normally only when
// `result.type === "completed"` and throws on every other outcome. So this frame is
// present exactly when the turn completed.
export const KIMI_TERMINAL_EVENT_TYPE = 'session.resume_hint'
const KIMI_RETRY_EVENT_TYPE = 'turn.step.retrying'

// Kimi's prompt-mode permission mode is not Ensync's to choose: resolveNativeSession
// pins it unconditionally, via setMode("auto") for a fresh session and forceAuto() for
// --session/--continue, regardless of -y/--yolo or --auto. Recorded as a constant so the
// containment record in host/chat.mjs and this runner cite the same verified fact.
export const KIMI_FORCED_PERMISSION_MODE = 'auto'

// Kimi delivers the prompt in argv and offers no stdin path for it: `-p, --prompt
// <prompt>` is declared with a required value and prompt mode reads `opts.prompt`
// directly. Ensync does not put prompts in argv, so this constant exists to make the
// conflict explicit at the point of use rather than leaving it as an unstated habit.
// It is the reason Kimi is gated in host/chat.mjs.
export const KIMI_PROMPT_TRANSPORT = 'argv'

export class KimiExecError extends Error {
  constructor(code, message, status = 502, safeToRetry = false) {
    super(message)
    this.name = 'KimiExecError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

/**
 * Builds the argument vector for one non-interactive Kimi run.
 *
 * Deliberately absent, each for a recorded reason:
 * - a bare `-S`/`--session`: the flag takes an OPTIONAL id, and without one it opens an
 *   interactive session picker, which is an immediate headless hang.
 * - `-c/--continue`: it resumes "the previous session for the working directory",
 *   which is ambient state Ensync has not chosen; a resume is always by explicit id.
 * - `--plan`, `--agent`, `--agent-file`, `--skills-dir`: they change the agent contract
 *   Ensync has not verified.
 * - `--add-dir`: it widens the declared workspace beyond the protected worktree, which
 *   is the opposite of containment.
 * - `-y/--yolo` and `--auto`: they are inert here. Prompt mode pins `auto` itself, so
 *   sending them would imply Ensync chose a permission mode it did not choose.
 */
export function kimiSessionArguments(input = {}) {
  const args = ['--prompt', String(input.prompt ?? ''), '--output-format', KIMI_OUTPUT_FORMAT]
  if (input.model) args.push('--model', input.model)
  if (input.sessionId) args.push('--session', input.sessionId)
  return args
}

/**
 * The argument vector with the prompt withheld. Kimi is the one provider whose prompt
 * lands in argv, so anything Ensync shows a person or writes to a log uses this form:
 * the whole point of keeping prompts off the command line is that command lines get
 * displayed and recorded.
 */
export function kimiVisibleArguments(input = {}) {
  return kimiSessionArguments(input).map((argument, index, all) => (
    all[index - 1] === '--prompt' ? '<prompt>' : argument
  ))
}

function truncate(value) {
  return value.length > MAX_TEXT_CHARACTERS ? value.slice(0, MAX_TEXT_CHARACTERS) : value
}

/**
 * Reads one NDJSON frame from Kimi's stdout. Verified shapes:
 * - {role:"assistant", content?, tool_calls?}
 * - {role:"tool", tool_call_id, content}
 * - {role:"meta", type:"turn.step.retrying", ...}
 * - {role:"meta", type:"session.resume_hint", session_id, command, content}
 * Anything else is returned as-is for the caller to ignore; nothing is guessed at.
 */
export function kimiParseFrame(line) {
  const trimmed = typeof line === 'string' ? line.trim() : ''
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function kimiIsTerminalFrame(frame) {
  return frame?.role === 'meta' && frame?.type === KIMI_TERMINAL_EVENT_TYPE
}

class KimiExecSession {
  #child
  #reader
  #stderr = ''
  #settled = false
  #startedTurn = false
  #assistantText = []
  #terminal = null
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
    const args = kimiSessionArguments(this.input)
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
      provider: 'kimi',
      cwd: this.input.projectPath,
      // The prompt is withheld: this string is shown and logged.
      command: [this.input.executable, ...kimiVisibleArguments(this.input)].join(' '),
      at: new Date(startedAt).toISOString(),
    })

    this.#reader = createInterface({ input: this.#child.stdout })
    this.#reader.on('line', (line) => this.#handleLine(line))
    this.#child.stderr.on('data', (chunk) => {
      this.#touch()
      this.#stderr = `${this.#stderr}${chunk.toString('utf8')}`.slice(0, MAX_STDERR_CHARACTERS)
    })
    this.#child.on('error', (error) => {
      this.#fail(new KimiExecError(
        'run_start_failed',
        `Kimi Code could not be started: ${error.message}`,
        502,
        !this.#startedTurn,
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
    this.#hardTimer = setTimeout(() => this.#fail(new KimiExecError(
      'run_timed_out',
      "Kimi Code reached Ensync Host's hard run limit and was stopped. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.hardTimeoutMs)
    this.#hardTimer.unref?.()
    this.signal?.addEventListener('abort', this.#abort, { once: true })
    if (this.signal?.aborted) this.#abort()

    try {
      // Prompt mode reads nothing from stdin; closing it immediately keeps the child
      // from ever waiting on a stream Ensync will not write to.
      this.#child.stdin.end()
      this.#startedTurn = true

      const exit = await this.#done
      if (!this.#terminal) throw this.#missingTerminalFailure(exit)

      const response = this.#assistantText.at(-1) ?? null
      if (!response) {
        throw new KimiExecError(
          'empty_cli_response',
          'Kimi Code completed the turn without a final assistant message.',
          502,
          false,
        )
      }
      return {
        provider: 'kimi',
        projectPath: this.input.projectPath,
        response,
        sessionId: typeof this.#terminal.session_id === 'string' && this.#terminal.session_id
          ? this.#terminal.session_id
          : null,
        model: null,
        requestedModel: this.input.model ?? null,
        // Kimi has no CLI effort flag at all: effort lives only in config.toml, so the
        // requested tier is recorded as asked-for and never claimed as applied.
        requestedEffort: this.input.effort ?? null,
        // stream-json carries no token counts. Reporting null is honest; inventing a
        // number from frame counts would not be.
        usage: null,
        outputRecovery: null,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof KimiExecError) throw error
      throw new KimiExecError(
        'kimi_exec_failed',
        'Kimi Code execution failed before Ensync received a verified completion.',
        502,
        !this.#startedTurn,
      )
    } finally {
      this.#finishProcess()
    }
  }

  /**
   * Explains an exit with no `session.resume_hint`. Because that frame is written only
   * on the completed path, its absence is proof the turn did not complete — including
   * when the process exited zero, which prompt mode can still do after writing a goal
   * summary. Ensync reports the run as unverified rather than assuming success.
   */
  #missingTerminalFailure(exit) {
    const detail = this.#stderr.trim()
      ? ` ${truncate(this.#stderr.trim()).slice(0, 500)}`
      : Number.isInteger(exit?.exitCode)
        ? ` It exited with code ${exit.exitCode}.`
        : exit?.signal
          ? ` It was terminated by ${exit.signal}.`
          : ''
    return new KimiExecError(
      'invalid_cli_output',
      `Kimi Code ended without the completion frame Ensync Host needs to verify the turn finished.${detail}`,
      502,
      !this.#startedTurn,
    )
  }

  #handleLine(line) {
    this.#touch()
    const frame = kimiParseFrame(line)
    if (!frame) return

    if (kimiIsTerminalFrame(frame)) {
      this.#terminal = frame
      return
    }
    if (frame.role === 'meta' && frame.type === KIMI_RETRY_EVENT_TYPE) {
      this.onEvent?.({
        type: 'notice',
        code: 'provider_retrying',
        message: `Kimi Code is retrying a step (attempt ${frame.failed_attempt ?? '?'} of ${frame.max_attempts ?? '?'}).`,
        at: new Date().toISOString(),
      })
      return
    }
    if (frame.role === 'assistant') {
      // A frame carrying tool_calls is progress, not an answer: PromptJsonWriter flushes
      // the pending assistant message whenever a step starts, so only the final flush is
      // the reply. Text that precedes tool work is released as a note instead.
      const text = typeof frame.content === 'string' ? frame.content.trim() : ''
      if (!text) return
      if (Array.isArray(frame.tool_calls) && frame.tool_calls.length > 0) {
        this.onEvent?.({
          type: 'note',
          provider: 'kimi',
          text: truncate(text),
          redacted: false,
          at: new Date().toISOString(),
        })
        return
      }
      this.#assistantText.push(truncate(text))
      return
    }
    if (frame.role === 'tool' && typeof frame.tool_call_id === 'string') {
      this.onEvent?.({
        type: 'output',
        stream: 'stdout',
        text: `\n> tool result (${frame.tool_call_id})\n`,
        redacted: false,
        at: new Date().toISOString(),
      })
    }
  }

  #abort = () => {
    this.#fail(new KimiExecError(
      'run_cancelled',
      'Run stopped by user. The provider process was terminated.',
      499,
      false,
    ))
  }

  #touch() {
    if (this.#settled || !Number.isFinite(this.inactivityTimeoutMs)) return
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer)
    this.#inactivityTimer = setTimeout(() => this.#fail(new KimiExecError(
      'run_timed_out',
      "Kimi Code produced no output before Ensync Host's inactivity limit and was stopped. Partial work may exist; review the project before retrying.",
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
    this.#reader?.close()
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

export class KimiExecRunner {
  #spawnProcess
  #inactivityTimeoutMs
  #hardTimeoutMs

  constructor(options = {}) {
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs
    this.#hardTimeoutMs = options.hardTimeoutMs
  }

  run(input, options = {}) {
    return new KimiExecSession(input, {
      ...options,
      spawnProcess: this.#spawnProcess,
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    }).run()
  }
}

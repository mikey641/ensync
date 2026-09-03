import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { commandInvocation } from './command.mjs'

// Pinned per Step 0 verification against the installed Cursor Agent CLI
// (cursor-agent 2026.08.04-aaa8809), read from its own bundled sources rather
// than guessed: `./src/commands/build-prompt.ts`, `./src/headless.ts`,
// `./src/shared/autorun-mode.ts`, and `./src/shared/unified-approval-policy.ts`.
//
// Three facts from those sources drive every choice in this runner:
//
//  1. Prompt on stdin. build-prompt joins the argv prompt array first and only
//     reads stdin when the argv prompt is EMPTY and stdin is not a TTY. Ensync
//     never puts a prompt in argv, so this runner passes no positional prompt
//     and writes the prompt to stdin instead. The CLI reads stdin to `end`, so
//     stdin MUST be closed after the write or the process waits forever.
//  2. Headless never prompts a human. `headless.ts` selects the decision
//     provider as `isHeadless ? (headlessAutoApprove ? AlwaysApprove
//     : AlwaysDeny) : AutorunAware`, and every interaction query (ask_user, web
//     search/fetch, mode switch) is answered from a fixed table. There is no
//     code path in which a headless run blocks on an approval dialog, which is
//     the failure mode that used to hang Droid runs at "Working".
//  3. Approval is all-or-nothing in headless. AlwaysDeny refuses every operation
//     (the agent cannot edit a file or run a command), so a useful run requires
//     the run-everything mode that `--force` selects. The persisted
//     `permissions.deny` allowlist in ~/.cursor/cli-config.json is NOT consulted
//     on the headless path. Containment therefore comes from the OS sandbox, not
//     from the approval layer. See CHAT_PROVIDER_CONTAINMENT in host/chat.mjs.
const CURSOR_PRINT_FLAG = '--print'
export const CURSOR_OUTPUT_FORMAT = 'stream-json'
// `--sandbox <enabled|disabled>` overrides both the persisted `sandbox.mode` and
// the server default (verified: the resolver is
// `sandboxOverride ?? config.sandbox.mode ?? serverDefault`). It is passed into
// the tool/executor construction independently of the decision provider, so it
// still applies under the always-approve provider that `--force` selects. On
// macOS the backend is Seatbelt via /usr/bin/sandbox-exec.
export const CURSOR_SANDBOX_MODE = 'enabled'
// Verified fail-closed behaviour: in headless mode, if the sandbox is enabled but
// unsupported on the host, the CLI exits 1 with
// "Sandbox mode is enabled but not available on this system" rather than
// silently running unsandboxed. Ensync relies on that, so it never has to guess
// whether containment took effect.
const CURSOR_FORCE_FLAG = '--force'

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const MAX_STDERR_CHARACTERS = 256 * 1024
const MAX_TEXT_CHARACTERS = 256 * 1024

// Verified terminal event. `headless.ts` writes exactly one
// `{"type":"result","subtype":"success","is_error":false,...}` line at the end
// of a completed turn, in all three machine-readable output modes. Failure and
// abort paths write NOTHING to stdout — they print to stderr and exit non-zero.
// A run without this line is therefore never treated as successful.
const RESULT_EVENT_TYPE = 'result'
const RESULT_SUCCESS_SUBTYPE = 'success'

// Verified stderr preambles emitted before any turn starts. Each one is a
// refusal the CLI makes on its own, so Ensync reports the real cause instead of
// a generic "the process exited" message.
const AUTHENTICATION_STDERR = 'Authentication required'
const SANDBOX_UNAVAILABLE_STDERR = 'Sandbox mode is enabled but not available on this system'
const RUN_EVERYTHING_DISABLED_STDERR = "Your team administrator has disabled the 'Run Everything' option"

export class CursorAgentError extends Error {
  constructor(code, message, status = 502, safeToRetry = false) {
    super(message)
    this.name = 'CursorAgentError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

/**
 * Builds the argv for one headless Cursor Agent turn.
 *
 * No positional prompt is ever appended: the prompt travels on stdin (see the
 * build-prompt note above). `--workspace` is passed in addition to the spawn
 * cwd so the workspace root is stated explicitly rather than inferred.
 */
export function cursorAgentArguments({ projectPath, sessionId = null, model = null }) {
  const args = [
    CURSOR_PRINT_FLAG,
    '--output-format', CURSOR_OUTPUT_FORMAT,
    '--sandbox', CURSOR_SANDBOX_MODE,
    CURSOR_FORCE_FLAG,
    '--workspace', projectPath,
  ]
  // `--resume [chatId]` takes an optional value, so the `=` form is the only
  // spelling that cannot swallow a following flag as its argument.
  if (typeof sessionId === 'string' && sessionId.trim()) args.push(`--resume=${sessionId.trim()}`)
  if (typeof model === 'string' && model.trim()) args.push('--model', model.trim())
  return args
}

export function parseCursorEventLine(line) {
  if (!line.trim()) return null
  try {
    const event = JSON.parse(line)
    return event && typeof event === 'object' && typeof event.type === 'string' ? event : null
  } catch {
    return null
  }
}

/**
 * Names the tool a `tool_call` event describes. The CLI serialises the
 * protobuf-es oneof as `{ tool: { case, value } }`; older/plain shapes that put
 * the variant name at the top level are tolerated so an unfamiliar payload
 * degrades to no label instead of throwing.
 */
export function cursorToolName(event) {
  const tool = event?.tool_call?.tool
  if (tool && typeof tool === 'object') {
    if (typeof tool.case === 'string' && tool.case) return tool.case
    const keys = Object.keys(tool)
    if (keys.length === 1) return keys[0]
  }
  return null
}

function truncate(value) {
  return value.length > MAX_TEXT_CHARACTERS ? value.slice(0, MAX_TEXT_CHARACTERS) : value
}

export function cursorMessageText(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Reads the verified token-usage shape off a terminal result event. The CLI
 * converts its protobuf BigInt counters to Numbers before serialising, so any
 * non-integer here is a payload Ensync does not recognise and is dropped rather
 * than reported as a count.
 */
export function cursorUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const integer = (candidate) => (Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null)
  const inputTokens = integer(usage.inputTokens)
  const outputTokens = integer(usage.outputTokens)
  const cachedInputTokens = integer(usage.cacheReadTokens)
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null
  return { source: 'cli', inputTokens, outputTokens, cachedInputTokens }
}

/**
 * Classifies a Cursor Agent process that ended without a terminal result event.
 * The CLI's own pre-turn refusals are reported as themselves; anything else is
 * an unexplained disconnect. `safeToRetry` is true only while no turn had begun,
 * because a stream that already carried tool work may have changed the project.
 */
export function cursorStartupFailure(stderr) {
  const detail = stderr.trim()
  if (detail.includes(AUTHENTICATION_STDERR)) {
    return new CursorAgentError(
      'provider_not_authenticated',
      'Cursor Agent reported that this machine is not signed in. Run `cursor-agent login` and try again.',
      409,
      true,
    )
  }
  if (detail.includes(SANDBOX_UNAVAILABLE_STDERR)) {
    return new CursorAgentError(
      'provider_containment_unverified',
      `Cursor Agent could not apply the pinned "${CURSOR_SANDBOX_MODE}" sandbox on this host, so Ensync stopped the run before any prompt was answered.`,
      409,
      false,
    )
  }
  if (detail.includes(RUN_EVERYTHING_DISABLED_STDERR)) {
    return new CursorAgentError(
      'provider_permission_declined',
      'Cursor Agent refused the run-everything mode Ensync pins for headless runs because a team administrator disabled it. Without it every tool call is denied, so Ensync did not start the turn.',
      409,
      false,
    )
  }
  return null
}

class CursorAgentSession {
  #child
  #reader
  #settled = false
  #turnStarted = false
  #sessionId = null
  #model = null
  #usage = null
  #pendingAssistantText = []
  #stderr = ''
  #hardTimer = null
  #inactivityTimer = null
  #forceKillTimer = null
  #resolveDone
  #rejectDone
  #done
  #resolveClosed
  #closed

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
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    void this.#done.catch(() => {})
  }

  async run() {
    const startedAt = Date.now()
    const args = cursorAgentArguments({
      projectPath: this.input.projectPath,
      sessionId: this.input.sessionId ?? null,
      model: this.input.model ?? null,
    })
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
      provider: 'cursor',
      cwd: this.input.projectPath,
      command: [this.input.executable, ...args].join(' '),
      at: new Date(startedAt).toISOString(),
    })

    this.#reader = createInterface({ input: this.#child.stdout })
    this.#reader.on('line', (line) => this.#handleLine(line))
    this.#child.stderr.on('data', (chunk) => {
      this.#touch()
      this.#stderr = `${this.#stderr}${chunk.toString('utf8')}`.slice(0, MAX_STDERR_CHARACTERS)
    })
    this.#child.on('error', (error) => {
      if (!this.#child.pid) this.#resolveClosed()
      this.#fail(new CursorAgentError(
        'run_start_failed',
        `Cursor Agent could not be started: ${error.message}`,
        502,
        !this.#turnStarted,
      ))
    })
    this.#child.on('close', (exitCode, signal) => this.#handleClose(exitCode, signal))
    this.#child.stdin.on('error', () => {
      // The close/error event is authoritative; a concurrent exit can close stdin first.
    })

    this.#touch()
    this.#hardTimer = setTimeout(() => this.#fail(new CursorAgentError(
      'run_timed_out',
      "Cursor Agent reached Ensync Host's hard run limit and was stopped. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.hardTimeoutMs)
    this.#hardTimer.unref?.()
    this.signal?.addEventListener('abort', this.#abort, { once: true })
    if (this.signal?.aborted) this.#abort()

    try {
      // The prompt goes on stdin and stdin is then closed: the CLI reads it to
      // `end`, so leaving it open would hang the turn before it starts.
      this.#writePrompt()
      const terminal = await this.#done
      const response = this.#finalResponse(terminal)
      if (!response) {
        throw new CursorAgentError(
          'empty_cli_response',
          'Cursor Agent reported a completed turn with no final answer.',
          502,
          false,
        )
      }
      return {
        provider: 'cursor',
        projectPath: this.input.projectPath,
        response,
        sessionId: this.#sessionId,
        model: this.#model,
        requestedModel: this.input.model ?? null,
        requestedEffort: this.input.effort ?? null,
        usage: cursorUsage(terminal.usage) ?? this.#usage,
        outputRecovery: null,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof CursorAgentError) throw error
      throw new CursorAgentError(
        'cursor_agent_failed',
        'Cursor Agent execution failed before Ensync received a verified completion.',
        502,
        !this.#turnStarted,
      )
    } finally {
      this.#finishProcess()
      await this.#closed
    }
  }

  #writePrompt() {
    if (this.#settled) return
    this.#turnStarted = true
    this.#child.stdin.write(this.input.prompt, 'utf8', (error) => {
      if (error) return
      if (!this.#child.stdin.destroyed) this.#child.stdin.end()
    })
  }

  #handleClose(exitCode, signal) {
    if (this.#forceKillTimer) clearTimeout(this.#forceKillTimer)
    this.#forceKillTimer = null
    this.#resolveClosed()
    if (this.#settled) return
    const recognised = cursorStartupFailure(this.#stderr)
    if (recognised) {
      this.#fail(recognised)
      return
    }
    const detail = this.#stderr.trim()
      ? ` ${this.#stderr.trim().slice(0, 500)}`
      : Number.isInteger(exitCode)
        ? ` It exited with code ${exitCode}.`
        : signal
          ? ` It was terminated by ${signal}.`
          : ''
    this.#fail(new CursorAgentError(
      'cursor_agent_disconnected',
      `Cursor Agent ended before it reported a completed turn.${detail}`,
      502,
      false,
    ))
  }

  #handleLine(line) {
    this.#touch()
    const event = parseCursorEventLine(line)
    // The CLI frames one JSON value per line on stdout, but it is not the only
    // writer: a plugin or shell integration can print a stray line. An
    // unparseable line is therefore ignored rather than treated as a protocol
    // fault, because the terminal result event is what proves completion.
    if (!event) return

    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.session_id === 'string' && event.session_id) this.#sessionId = event.session_id
      if (typeof event.model === 'string' && event.model) this.#model = event.model
      return
    }
    if (typeof event.session_id === 'string' && event.session_id && !this.#sessionId) {
      this.#sessionId = event.session_id
    }

    if (event.type === 'assistant') {
      const text = cursorMessageText(event.message)
      if (text) this.#pendingAssistantText.push(truncate(text))
      return
    }
    if (event.type === 'tool_call') {
      if (event.subtype !== 'started') return
      // Text that precedes tool work is provider-authored progress, not the
      // final answer, so it is released as a note exactly once.
      this.#flushNotes()
      const toolName = cursorToolName(event)
      if (toolName) {
        this.onEvent?.({
          type: 'output',
          stream: 'stdout',
          text: `\n> ${toolName}\n`,
          redacted: false,
          at: new Date().toISOString(),
        })
      }
      return
    }
    if (event.type === 'interaction_query' && event.subtype === 'request') {
      // Verified: a headless run answers every interaction query from a fixed
      // table and never waits for a person. The person is told what was skipped
      // rather than left wondering why the agent proceeded without an answer.
      this.onEvent?.({
        type: 'notice',
        code: 'provider_request_declined',
        message: `Cursor Agent raised an interactive request (${event.query_type ?? 'unknown'}) that a headless run answers automatically without asking a person.`,
        at: new Date().toISOString(),
      })
      return
    }
    if (event.type === RESULT_EVENT_TYPE) {
      this.#settled = true
      if (event.subtype === RESULT_SUCCESS_SUBTYPE && event.is_error !== true) {
        this.#resolveDone(event)
        return
      }
      this.#rejectDone(new CursorAgentError(
        'cli_failed',
        `Cursor Agent ended the turn without a completed result (subtype: ${typeof event.subtype === 'string' ? event.subtype : 'unknown'}).`,
        502,
        false,
      ))
      this.#terminate()
    }
  }

  #finalResponse(terminal) {
    const result = typeof terminal?.result === 'string' ? terminal.result.trim() : ''
    if (result) return truncate(result)
    const pending = this.#pendingAssistantText.at(-1)
    return typeof pending === 'string' && pending.trim() ? pending.trim() : null
  }

  #flushNotes() {
    for (const text of this.#pendingAssistantText) {
      this.onEvent?.({
        type: 'note',
        provider: 'cursor',
        text,
        redacted: false,
        at: new Date().toISOString(),
      })
    }
    this.#pendingAssistantText = []
  }

  #abort = () => {
    if (this.#settled) return
    this.#fail(new CursorAgentError(
      'run_cancelled',
      'Run stopped by user. The provider process was terminated.',
      499,
      false,
    ))
  }

  #touch() {
    if (this.#settled || !Number.isFinite(this.inactivityTimeoutMs)) return
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer)
    this.#inactivityTimer = setTimeout(() => this.#fail(new CursorAgentError(
      'run_timed_out',
      "Cursor Agent produced no output before Ensync Host's inactivity limit and was stopped. Partial work may exist; review the project before retrying.",
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
      this.#forceKillTimer = setTimeout(() => {
        this.#forceKillTimer = null
        if (this.#child.exitCode === null && this.#child.signalCode === null) {
          try { this.#child.kill('SIGKILL') } catch { /* A concurrent exit needs no cleanup. */ }
        }
      }, 1_000)
    }
  }

  #terminate() {
    if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) return
    try {
      // Verified: the CLI installs a SIGINT handler that aborts the turn and
      // flushes its transcript, so an interrupt is the graceful stop. SIGKILL is
      // only the escalation when it does not exit.
      this.#child.kill('SIGINT')
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
  }
}

export class CursorAgentRunner {
  #spawnProcess
  #inactivityTimeoutMs
  #hardTimeoutMs

  constructor(options = {}) {
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs
    this.#hardTimeoutMs = options.hardTimeoutMs
  }

  run(input, options = {}) {
    return new CursorAgentSession(input, {
      ...options,
      spawnProcess: this.#spawnProcess,
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    }).run()
  }
}

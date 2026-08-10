import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { realpath } from 'node:fs/promises'
import { commandInvocation } from './command.mjs'

// Pinned per Step 0 verification against the installed CodeBuddy Code CLI
// (@tencent-ai/codebuddy-code 2.133.1), driven as
// `codebuddy --print --verbose --output-format stream-json`.
//
// CodeBuddy is a Claude Code-family CLI: the same `-p` + stream-json contract,
// the same `system`/`result` event vocabulary, and the same
// `settings.permissions.{allow,deny}` rule grammar. That similarity is used
// deliberately, never assumed — every behaviour encoded here was re-observed
// against this binary and is recorded in docs/providers/codebuddy.md.
//
// Every verification probe ran with an EMPTY prompt on stdin, which the CLI
// reports as `duration_api_ms: 0` / `total_cost_usd: 0` / `input_tokens: 0`.
// No model turn was ever billed to map this provider.

// CodeBuddy's own mode descriptions, read from dist/codebuddy-headless.js:
//   default            "Prompts for permission on first use of each tool"
//   acceptEdits        "Automatically accepts file edit permissions for the session"
//   dontAsk            "Never shows permission prompts; runs pre-approved and safe
//                       actions, denies anything that would require approval"
//   bypassPermissions  "Skips all permission prompts"
//
// `acceptEdits` is pinned: it is the weakest mode that still lets Ensync's
// contained worktree edits proceed without a blanket bypass. `bypassPermissions`
// would discard the deny rules' only enforcement point, and `dontAsk` denies the
// very file writes a coding task exists to make. The renderer cannot choose this.
export const CODEBUDDY_PERMISSION_MODE = 'acceptEdits'

// Ensync's friendly Model size tiers map onto four members of CodeBuddy's
// `--effort` enum (full enum: minimal, low, medium, high, xhigh, max). Ensync
// never sends the members its size selector does not define.
export const CODEBUDDY_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'max'])

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const MAX_STDERR_CHARACTERS = 256 * 1024
const MAX_TEXT_CHARACTERS = 256 * 1024

const QUOTA_PATTERN = /(?:usage|spending|rate)[\s_-]*limit|quota|out of credits|insufficient credits|credit balance|too many requests|overloaded/i
const AUTHENTICATION_PATTERN = /authentication required|not (?:signed|logged) in|please use \/login|unauthorized/i

export class CodebuddyExecError extends Error {
  constructor(code, message, status = 502, safeToRetry = false) {
    super(message)
    this.name = 'CodebuddyExecError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

/**
 * Deny rules keeping the canonical shared checkout out of reach. Verified: the
 * rule grammar is `ToolName(ruleContent)` (the CLI's own `ruleValueToString`
 * builds exactly that), and `--settings` accepts a JSON string.
 *
 * This is a fail-open gap, not a sandbox — see the CHAT_PROVIDER_CONTAINMENT
 * codebuddy record. A malformed --settings payload is silently ignored
 * (verified: `--settings '{{{not json'` produced a normal run and exit 0), and
 * shell-tool commands are governed by command-prefix rules rather than the file
 * globs used here.
 */
export function codebuddyContainmentArguments(containment) {
  if (!containment) return []
  const settings = {
    permissions: {
      deny: [
        `Write(${containment.canonicalRepositoryPath}/**)`,
        `Edit(${containment.canonicalRepositoryPath}/**)`,
        `NotebookEdit(${containment.canonicalRepositoryPath}/**)`,
      ],
    },
  }
  return ['--settings', JSON.stringify(settings)]
}

/**
 * `--verbose` is required for `--output-format stream-json` to emit the full
 * event stream. `--add-dir` is deliberately never passed: a non-existent
 * directory makes the CLI print a bare `"<path> not found"` line into the middle
 * of the JSON stream (verified), and Ensync should not depend on stream repair
 * for something it does not need.
 */
export function codebuddyArguments(input = {}, containment = null) {
  const args = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--permission-mode',
    CODEBUDDY_PERMISSION_MODE,
  ]
  if (input.model) args.push('--model', input.model)
  if (input.effort && CODEBUDDY_REASONING_EFFORTS.has(input.effort)) {
    args.push('--effort', input.effort)
  }
  // `--resume <id>` continues an existing conversation. `--session-id` names a
  // NEW session instead, so it is never used for continuation.
  if (input.sessionId) args.push('--resume', input.sessionId)
  args.push(...codebuddyContainmentArguments(containment))
  return args
}

function truncate(value) {
  return value.length > MAX_TEXT_CHARACTERS ? value.slice(0, MAX_TEXT_CHARACTERS) : value
}

function normalizePath(value) {
  if (typeof value !== 'string' || !value) return null
  const trimmed = value.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * Explains why an observed `system.init` fails to prove containment, or returns
 * null when it proves it.
 *
 * This check exists because `--permission-mode` is fail-open: verified against
 * codebuddy 2.133.1, `--permission-mode __bogus__` is silently discarded and the
 * session reports `permissionMode: "default"` with no error and exit 0. Sending
 * the flag is therefore not proof it applied. `system.init` echoing the
 * effective mode is the only trustworthy report, and it arrives before any model
 * call — so the prompt can be withheld until the echo matches.
 */
export function codebuddyContainmentMismatch(init, expectedCwd) {
  if (!init || typeof init !== 'object') {
    return 'CodeBuddy did not report a session initialization event'
  }
  const mode = init.permissionMode
  if (mode !== CODEBUDDY_PERMISSION_MODE) {
    return `CodeBuddy reported permission mode "${typeof mode === 'string' && mode ? mode : 'none'}" instead of the pinned "${CODEBUDDY_PERMISSION_MODE}"`
  }
  const reported = normalizePath(init.cwd)
  const expected = normalizePath(expectedCwd)
  if (expected && reported !== expected) {
    return `CodeBuddy reported working directory "${reported ?? 'none'}" instead of the protected "${expected}"`
  }
  return null
}

/** Verified terminal event: one line with `type: "result"`. */
export function codebuddyTerminalResult(events) {
  return [...events].reverse().find((event) => event?.type === 'result') ?? null
}

function assistantMessageText(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Classifies a failing terminal result. CodeBuddy exposes no protocol-level
 * quota or authentication reason the way droid does (see docs/providers/codebuddy.md
 * "Stated unknowns"), so this falls back to text matching and says so.
 */
function resultFailure(result) {
  const text = typeof result?.result === 'string' ? result.result : ''
  const subtype = typeof result?.subtype === 'string' ? result.subtype : 'unknown'
  if (QUOTA_PATTERN.test(text)) {
    return new CodebuddyExecError(
      'provider_quota',
      'CodeBuddy reported that this account’s usage or credit allowance is exhausted.',
      429,
      false,
    )
  }
  if (AUTHENTICATION_PATTERN.test(text)) {
    return new CodebuddyExecError(
      'provider_not_authenticated',
      'CodeBuddy is not signed in. Sign in to CodeBuddy Code and try again.',
      409,
      false,
    )
  }
  return new CodebuddyExecError(
    'cli_failed',
    text.trim()
      ? `CodeBuddy reported an error (${subtype}): ${truncate(text.trim())}`
      : `CodeBuddy ended the run without a completed result (${subtype}).`,
    502,
    false,
  )
}

class CodebuddyExecSession {
  #child
  #reader
  #events = []
  #init = null
  #promptSent = false
  #settled = false
  #finalText = null
  #pendingAssistantText = []
  #stderr = ''
  #nonJsonLines = 0
  #hardTimer = null
  #inactivityTimer = null
  #forceKillTimer = null
  #resolveDone
  #rejectDone
  #done
  #resolveInit
  #initPromise

  constructor(input, options = {}) {
    this.input = input
    this.onEvent = options.onEvent
    this.signal = options.signal
    this.spawnProcess = options.spawnProcess ?? spawn
    this.resolvePath = options.resolvePath ?? ((path) => realpath(path))
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
    this.hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS
    this.#done = new Promise((resolve, reject) => {
      this.#resolveDone = resolve
      this.#rejectDone = reject
    })
    void this.#done.catch(() => {})
    this.#initPromise = new Promise((resolve) => { this.#resolveInit = resolve })
  }

  async run() {
    const startedAt = Date.now()
    const containment = this.input.containment ?? null
    const args = codebuddyArguments(this.input, containment)
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
      provider: 'codebuddy',
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
      this.#fail(new CodebuddyExecError(
        'run_start_failed',
        `CodeBuddy could not be started: ${error.message}`,
        502,
        !this.#promptSent,
      ))
    })
    this.#child.on('close', (exitCode, signal) => {
      // The verified terminal event is the `result` line, never the exit status:
      // resuming an unknown session prints a single `{"type":"error",...}` line
      // and still exits 0. A close without a result is always a failure here.
      if (this.#settled) return
      this.#fail(this.#disconnectedFailure(exitCode, signal))
    })
    this.#child.stdin.on('error', () => {
      // The close/error event is authoritative; a concurrent exit can close stdin first.
    })

    this.#touch()
    this.#hardTimer = setTimeout(() => this.#fail(new CodebuddyExecError(
      'run_timed_out',
      "CodeBuddy reached Ensync Host's hard run limit and was stopped. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.hardTimeoutMs)
    this.#hardTimer.unref?.()
    this.signal?.addEventListener('abort', this.#abort, { once: true })
    if (this.signal?.aborted) this.#abort()

    try {
      await this.#sendPromptOnceContained()
      const result = await this.#done
      if (result.is_error === true) throw resultFailure(result)
      if (result.is_error !== false) {
        throw new CodebuddyExecError(
          'invalid_cli_output',
          'CodeBuddy returned no verified success state.',
          502,
          false,
        )
      }
      const response = this.#finalResponse(result)
      if (!response) {
        throw new CodebuddyExecError(
          'empty_cli_response',
          'CodeBuddy finished without a verifiable final agent response.',
          502,
          false,
        )
      }
      return {
        provider: 'codebuddy',
        projectPath: this.input.projectPath,
        response,
        sessionId: this.#sessionId(result),
        model: this.#model(result),
        requestedModel: this.input.model ?? null,
        requestedEffort: this.input.effort ?? null,
        usage: usageFrom(result.usage),
        outputRecovery: null,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof CodebuddyExecError) throw error
      throw new CodebuddyExecError(
        'codebuddy_exec_failed',
        'CodeBuddy execution failed before Ensync received a verified completion.',
        502,
        !this.#promptSent,
      )
    } finally {
      this.#finishProcess()
    }
  }

  /**
   * Withholds the prompt until the CLI has echoed the pinned permission mode and
   * the protected working directory back in `system.init`. This is the whole
   * reason CodeBuddy is driven as a held-open stdin session rather than a
   * fire-and-forget `runProcess` call: because the mode flag fails open, the
   * only safe moment to commit the prompt is after the echo has been read.
   */
  async #sendPromptOnceContained() {
    const init = await Promise.race([
      this.#initPromise,
      this.#done.then(() => null, () => null),
    ])
    if (this.#settled && !init) {
      // The run already failed (or was cancelled) before init arrived; let the
      // recorded failure surface instead of masking it with a containment error.
      await this.#done
      return
    }
    const expectedCwd = await this.#expectedCwd()
    const mismatch = codebuddyContainmentMismatch(init, expectedCwd)
    if (mismatch) {
      throw new CodebuddyExecError(
        'provider_containment_unverified',
        `${mismatch}. No prompt was sent.`,
        409,
        true,
      )
    }
    this.#child.stdin.write(this.input.prompt, 'utf8')
    this.#child.stdin.end()
    this.#promptSent = true
  }

  async #expectedCwd() {
    try {
      return await this.resolvePath(this.input.projectPath)
    } catch {
      // A path the Host cannot resolve is still worth comparing literally.
      return this.input.projectPath
    }
  }

  #disconnectedFailure(exitCode, signal) {
    const stderr = this.#stderr.trim()
    const errorEvent = [...this.#events].reverse().find((event) => event?.type === 'error')
    if (errorEvent && typeof errorEvent.error === 'string' && errorEvent.error.trim()) {
      const text = errorEvent.error.trim()
      if (/no conversation found with session id/i.test(text)) {
        return new CodebuddyExecError(
          'invalid_session',
          `CodeBuddy could not resume this conversation: ${truncate(text)}`,
          409,
          false,
        )
      }
      return new CodebuddyExecError('cli_failed', `CodeBuddy reported an error: ${truncate(text)}`, 502, !this.#promptSent)
    }
    if (stderr && AUTHENTICATION_PATTERN.test(stderr)) {
      return new CodebuddyExecError(
        'provider_not_authenticated',
        'CodeBuddy is not signed in. Sign in to CodeBuddy Code and try again.',
        409,
        false,
      )
    }
    const detail = stderr
      ? ` ${stderr.slice(0, 500)}`
      : Number.isInteger(exitCode)
        ? ` It exited with code ${exitCode}.`
        : signal
          ? ` It was terminated by ${signal}.`
          : ''
    return new CodebuddyExecError(
      'codebuddy_exec_disconnected',
      `CodeBuddy ended before returning a verified result event.${detail}`,
      502,
      !this.#promptSent,
    )
  }

  #finalResponse(result) {
    if (typeof result?.result === 'string' && result.result.trim()) return truncate(result.result.trim())
    const pending = this.#pendingAssistantText.at(-1)
    if (typeof pending === 'string' && pending.trim()) return truncate(pending.trim())
    return typeof this.#finalText === 'string' && this.#finalText.trim() ? truncate(this.#finalText.trim()) : null
  }

  #sessionId(result) {
    if (typeof result?.session_id === 'string' && result.session_id) return result.session_id
    return typeof this.#init?.session_id === 'string' ? this.#init.session_id : null
  }

  #model(result) {
    const usage = result?.modelUsage && typeof result.modelUsage === 'object'
      ? Object.keys(result.modelUsage)
      : []
    if (usage.length === 1) return usage[0]
    const reported = this.#init?.model
    // A logged-out session reports the literal string "unknown"; it is not a model.
    return typeof reported === 'string' && reported && reported !== 'unknown' ? reported : null
  }

  #abort = () => {
    if (this.#settled) return
    this.#fail(new CodebuddyExecError(
      'run_cancelled',
      'Run stopped by user. The provider process was terminated.',
      499,
      false,
    ))
  }

  #handleLine(line) {
    this.#touch()
    if (!line.trim()) return
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // Verified: CodeBuddy can emit a bare non-JSON diagnostic line into the
      // stream (e.g. an `--add-dir` path that does not exist). One stray line is
      // forwarded as output rather than failing the run, but a stream that is
      // mostly unparseable is not verifiable protocol state.
      this.#nonJsonLines += 1
      if (this.#nonJsonLines > 50) {
        this.#fail(new CodebuddyExecError(
          'invalid_cli_output',
          'CodeBuddy produced output Ensync Host could not verify as a JSON event stream.',
          502,
          false,
        ))
        return
      }
      this.onEvent?.({
        type: 'output',
        stream: 'stdout',
        text: `${line}\n`,
        redacted: false,
        at: new Date().toISOString(),
      })
      return
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return
    this.#events.push(event)

    if (event.type === 'system' && event.subtype === 'init') {
      this.#init = event
      this.#resolveInit(event)
      return
    }
    if (event.type === 'assistant') {
      this.#handleMessage(event.message)
      return
    }
    if (event.type === 'result') {
      this.#settled = true
      this.#resolveDone(event)
    }
  }

  #handleMessage(message) {
    if (!message || typeof message !== 'object') return
    const text = assistantMessageText(message)
    if (text) {
      this.#pendingAssistantText.push(truncate(text))
      this.#finalText = truncate(text)
      this.onEvent?.({
        type: 'note',
        provider: 'codebuddy',
        text: truncate(text),
        redacted: false,
        at: new Date().toISOString(),
      })
      return
    }
    if (!Array.isArray(message.content)) return
    for (const block of message.content) {
      if (block?.type !== 'tool_use') continue
      const name = typeof block.name === 'string' ? block.name : null
      if (!name) continue
      // Only the tool name is surfaced; tool input can carry command text and
      // secrets and never reaches an Ensync notice.
      this.onEvent?.({
        type: 'output',
        stream: 'stdout',
        text: `\n> ${name}\n`,
        redacted: false,
        at: new Date().toISOString(),
      })
    }
  }

  #touch() {
    if (this.#settled || !Number.isFinite(this.inactivityTimeoutMs)) return
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer)
    // CodeBuddy's headless approval behaviour is UNVERIFIED (no authenticated
    // turn has ever been observed). If an approval request can block a `-p` run,
    // this watchdog is what turns a droid-style forever-"Working" hang into an
    // honest timeout.
    this.#inactivityTimer = setTimeout(() => this.#fail(new CodebuddyExecError(
      'run_timed_out',
      "CodeBuddy produced no output before Ensync Host's inactivity limit and was stopped. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.inactivityTimeoutMs)
    this.#inactivityTimer.unref?.()
  }

  #fail(error) {
    if (this.#settled) return
    this.#settled = true
    this.#resolveInit(null)
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

function usageFrom(usage) {
  if (!usage || typeof usage !== 'object') return null
  const integer = (candidate) => (Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null)
  const inputTokens = integer(usage.input_tokens)
  const outputTokens = integer(usage.output_tokens)
  const cachedInputTokens = integer(usage.cache_read_input_tokens)
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null
  return { source: 'cli', inputTokens, outputTokens, cachedInputTokens }
}

export class CodebuddyExecRunner {
  #spawnProcess
  #inactivityTimeoutMs
  #hardTimeoutMs
  #resolvePath

  constructor(options = {}) {
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs
    this.#hardTimeoutMs = options.hardTimeoutMs
    this.#resolvePath = options.resolvePath
  }

  async run(input, options = {}) {
    const session = new CodebuddyExecSession(input, {
      ...options,
      spawnProcess: this.#spawnProcess,
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
      resolvePath: this.#resolvePath,
    })
    return session.run()
  }
}

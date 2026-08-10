import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { extname } from 'node:path'
import { commandInvocation } from './command.mjs'
import {
  ProviderQuestionRegistry,
  droidAskUserResult,
  normalizeDroidQuestions,
  providerQuestionEvent,
  providerQuestionResolvedEvent,
} from './provider-questions.mjs'

// Pinned per Step 0 verification against the installed Factory Droid CLI
// (droid 0.190.0, reporting factoryProtocolVersion 1.154.0) driven over
// `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`.
//
// The exec runner validates every stdin line against a discriminated-union
// envelope before it dispatches a method, and rejects anything else with
// -32700 "Invalid JSON-RPC message" and a null id. The envelope requires
// `jsonrpc: "2.0"`, a `factoryApiVersion` literal of "1.0.0", a `type`
// discriminator, and — for requests — a **string** `id`. A numeric id or a
// missing factoryApiVersion is refused before method routing, so an unknown
// method cannot be distinguished from a malformed envelope. Do not guess these
// values; they are literals in the CLI's own request schema.
const JSONRPC_VERSION = '2.0'
const FACTORY_API_VERSION = '1.0.0'

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const MAX_STDERR_CHARACTERS = 256 * 1024
const MAX_TEXT_CHARACTERS = 256 * 1024
const DROID_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp'])

// Ensync's friendly Model size tiers map 1:1 onto four members of Droid's own
// `reasoningEffort` enum (verified full enum: none, dynamic, off, minimal, low,
// medium, high, xhigh, max). Ensync never exposes the other members because it
// never invents effort values the size selector does not define.
const DROID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'max'])

// Droid expresses workspace containment as a risk-tiered autonomy level rather
// than a path-scoped rule, so the Host pins one level per run. `medium` is the
// documented tier that permits project file edits plus ordinary local build,
// test, and git operations while refusing `git push`, sudo, and production
// changes. The renderer cannot choose this value.
export const DROID_AUTONOMY_LEVEL = 'medium'
// `auto` is Droid's ordinary conversational mode. Pinning it keeps a run out of
// spec and mission modes, which have different approval and orchestration
// semantics that Ensync has not verified.
export const DROID_INTERACTION_MODE = 'auto'

// Verified enum for `agent_turn_completed.reason`. `completed` is the only
// success value; every other member ends the turn without a verified answer.
const TURN_REASON_COMPLETED = 'completed'
const TURN_REASON_CANCELLED = 'cancelled'
// Droid reports subscription exhaustion and provider capacity as exact terminal
// reasons, so Ensync classifies them from the protocol instead of matching text.
const QUOTA_TURN_REASONS = new Set([
  'model_usage_exhausted',
  'model_provider_unavailable',
])
const AUTHENTICATION_TURN_REASONS = new Set(['model_authentication_failed'])

// Session notifications that are pure lifecycle, reasoning, or agent text.
// Anything outside this set — every tool, permission, hook, child-session, and
// mission event, plus any notification type a later CLI adds — counts as
// activity and denies an automatic retry.
const NON_ACTIVITY_NOTIFICATIONS = new Set([
  'assistant_text_complete',
  'assistant_text_delta',
  'droid_working_state_changed',
  'llm_retry',
  'loop_state_changed',
  'mcp_status_changed',
  'queued_messages_discarded',
  'session_compacted',
  'session_title_updated',
  'session_token_usage_changed',
  'session_working_directory_changed',
  'settings_updated',
  'structured_output',
  'thinking_text_complete',
  'thinking_text_delta',
])
// `create_message` carries a whole message, so it only proves "no activity"
// when its content blocks are text or reasoning. A tool_use or tool_result
// block inside it is real work.
const NON_ACTIVITY_CONTENT_BLOCKS = new Set(['text', 'thinking', 'reasoning', 'reasoning_content'])

export class DroidExecError extends Error {
  constructor(code, message, status = 502, safeToRetry = false) {
    super(message)
    this.name = 'DroidExecError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

export function droidRequestEnvelope(id, method, params) {
  return {
    jsonrpc: JSONRPC_VERSION,
    factoryApiVersion: FACTORY_API_VERSION,
    type: 'request',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  }
}

export function droidImagePaths(attachmentPaths = []) {
  return attachmentPaths.filter((path) => DROID_IMAGE_EXTENSIONS.has(extname(path).toLowerCase()))
}

export function droidSessionArguments() {
  return ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc']
}

function truncate(value) {
  return value.length > MAX_TEXT_CHARACTERS ? value.slice(0, MAX_TEXT_CHARACTERS) : value
}

function assistantMessageText(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

function messageProvesNoActivity(message) {
  if (!message || typeof message !== 'object') return false
  if (!['user', 'assistant'].includes(message.role)) return false
  if (!Array.isArray(message.content)) return false
  return message.content.every((block) =>
    block
    && typeof block === 'object'
    && NON_ACTIVITY_CONTENT_BLOCKS.has(block.type))
}

/**
 * Proves that a failed Droid turn performed no tool, command, file, or unknown
 * work. Mirrors the Codex and Claude contracts: the stream must end in a
 * terminal provider failure and every preceding notification must be a known
 * non-mutating lifecycle, reasoning, or agent-text event.
 */
export function droidTurnProvesNoActivity(notifications) {
  const terminal = notifications.at(-1)
  if (terminal?.type !== 'agent_turn_completed' || terminal.reason === TURN_REASON_COMPLETED) return false

  return !notifications.some((notification, index) => {
    if (index === notifications.length - 1) return false
    if (notification?.type === 'create_message') return !messageProvesNoActivity(notification.message)
    if (notification?.type === 'error') return false
    return !NON_ACTIVITY_NOTIFICATIONS.has(notification?.type)
  })
}

function usageFrom(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null
  const integer = (candidate) => (Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null)
  const inputTokens = integer(tokenUsage.inputTokens)
  const outputTokens = integer(tokenUsage.outputTokens)
  const cachedInputTokens = integer(tokenUsage.cacheReadTokens)
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null
  return { source: 'cli', inputTokens, outputTokens, cachedInputTokens }
}

function turnFailure(terminal, safeToRetry) {
  const reason = typeof terminal?.reason === 'string' ? terminal.reason : 'unknown'
  if (reason === TURN_REASON_CANCELLED) {
    return new DroidExecError(
      'run_cancelled',
      'Run stopped by user. The provider process was terminated.',
      499,
      false,
    )
  }
  if (QUOTA_TURN_REASONS.has(reason)) {
    return new DroidExecError(
      'provider_quota',
      'Factory Droid reported that this account\u2019s model usage is exhausted or the provider is unavailable.',
      429,
      safeToRetry,
    )
  }
  if (AUTHENTICATION_TURN_REASONS.has(reason)) {
    return new DroidExecError(
      'provider_not_authenticated',
      'Factory Droid reported that the model request was not authenticated.',
      409,
      safeToRetry,
    )
  }
  return new DroidExecError(
    'cli_failed',
    `Factory Droid ended the turn without a completed result (reason: ${reason}).`,
    502,
    false,
  )
}

class DroidExecSession {
  #child
  #reader
  #requests = new Map()
  #nextRequestId = 1
  #sessionId = null
  #turnStarted = false
  #settled = false
  #notifications = []
  #pendingAssistantText = []
  #finalText = null
  #model = null
  #usage = null
  #settings = null
  #stderr = ''
  #hardTimer = null
  #inactivityTimer = null
  #forceKillTimer = null
  #inactivityHeld = false
  #questions
  #resolveDone
  #rejectDone
  #done

  constructor(input, options = {}) {
    this.input = input
    this.onEvent = options.onEvent
    this.signal = options.signal
    // Questions need a retained job to route the answer back to, so a run
    // without one keeps the original decline-safely behaviour.
    this.#questions = options.questionsEnabled === true
      ? new ProviderQuestionRegistry({ idPrefix: 'droid' })
      : null
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
    const args = droidSessionArguments()
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
      provider: 'droid',
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
      this.#fail(new DroidExecError(
        'run_start_failed',
        `Factory Droid could not be started: ${error.message}`,
        502,
        !this.#turnStarted,
      ))
    })
    this.#child.on('close', (exitCode, signal) => {
      if (this.#settled) return
      const detail = this.#stderr.trim()
        ? ` ${this.#stderr.trim().slice(0, 500)}`
        : Number.isInteger(exitCode)
          ? ` It exited with code ${exitCode}.`
          : signal
            ? ` It was terminated by ${signal}.`
            : ''
      this.#fail(new DroidExecError(
        'droid_exec_disconnected',
        `Factory Droid ended before the turn completed.${detail}`,
        502,
        !this.#turnStarted,
      ))
    })
    this.#child.stdin.on('error', () => {
      // The close/error event is authoritative; a concurrent exit can close stdin first.
    })

    this.#touch()
    this.#hardTimer = setTimeout(() => this.#fail(new DroidExecError(
      'run_timed_out',
      "Factory Droid reached Ensync Host's hard run limit and was stopped. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.hardTimeoutMs)
    this.#hardTimer.unref?.()
    this.signal?.addEventListener('abort', this.#abort, { once: true })
    if (this.signal?.aborted) this.#abort()

    try {
      await this.#openSession()
      this.#assertContainmentPinned()

      const imagePaths = droidImagePaths(this.input.attachmentPaths ?? [])
      await this.#request('droid.add_user_message', {
        text: this.input.prompt,
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
      })
      this.#turnStarted = true

      const terminal = await this.#done
      if (terminal.reason !== TURN_REASON_COMPLETED) {
        throw turnFailure(terminal, droidTurnProvesNoActivity(this.#notifications))
      }
      const response = this.#finalResponse()
      if (!response) {
        throw new DroidExecError(
          'empty_cli_response',
          'Factory Droid finished without a verifiable final agent response.',
          502,
          false,
        )
      }
      return {
        provider: 'droid',
        projectPath: this.input.projectPath,
        response,
        sessionId: this.#sessionId,
        model: this.#model,
        requestedModel: this.input.model ?? null,
        requestedEffort: this.input.effort ?? null,
        usage: usageFrom(terminal.tokenUsage) ?? this.#usage,
        outputRecovery: null,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof DroidExecError) throw error
      throw new DroidExecError(
        'droid_exec_failed',
        'Factory Droid execution failed before Ensync received a verified completion.',
        502,
        !this.#turnStarted,
      )
    } finally {
      this.#finishProcess()
    }
  }

  async #openSession() {
    // Both initialize_session and load_session return the session's effective
    // settings, which is the only trustworthy report of the autonomy level
    // Droid actually applied.
    if (this.input.sessionId) {
      const loaded = await this.#request('droid.load_session', { sessionId: this.input.sessionId })
      this.#sessionId = typeof loaded?.sessionId === 'string' ? loaded.sessionId : this.input.sessionId
      this.#rememberSettings(loaded?.settings)
      const updated = await this.#request('droid.update_session_settings', this.#pinnedSettings())
      this.#rememberSettings(updated?.settings)
      return
    }
    const created = await this.#request('droid.initialize_session', {
      machineId: 'ensync-host',
      cwd: this.input.projectPath,
      ...this.#pinnedSettings(),
    })
    this.#sessionId = typeof created?.sessionId === 'string' ? created.sessionId : null
    this.#rememberSettings(created?.settings)
    if (!this.#sessionId) {
      throw new DroidExecError(
        'invalid_cli_output',
        'Factory Droid did not return a valid session ID.',
        502,
        true,
      )
    }
  }

  #pinnedSettings() {
    return {
      autonomyLevel: DROID_AUTONOMY_LEVEL,
      interactionMode: DROID_INTERACTION_MODE,
      ...(this.input.model ? { modelId: this.input.model } : {}),
      ...(this.input.effort && DROID_REASONING_EFFORTS.has(this.input.effort)
        ? { reasoningEffort: this.input.effort }
        : {}),
    }
  }

  #rememberSettings(settings) {
    if (!settings || typeof settings !== 'object') return
    this.#settings = { ...this.#settings, ...settings }
    if (typeof settings.modelId === 'string' && settings.modelId.trim()) {
      this.#model = settings.modelId.trim()
    }
  }

  // Droid's session settings schema declares autonomyLevel and interactionMode
  // as `.optional().catch(void 0)`: an unrecognised value is silently discarded
  // rather than rejected, so the request alone is not proof of containment.
  // Verified against droid 0.190.0 — sending `autonomyLevel: "__bogus__"`
  // returns no error and leaves the account default in force. Ensync therefore
  // refuses to send the prompt unless the CLI echoes back the pinned level.
  #assertContainmentPinned() {
    const applied = this.#settings?.autonomyLevel
    if (applied === DROID_AUTONOMY_LEVEL) return
    throw new DroidExecError(
      'provider_containment_unverified',
      `Factory Droid did not confirm the pinned "${DROID_AUTONOMY_LEVEL}" autonomy level for this run (reported: ${applied ?? 'none'}). No prompt was sent.`,
      409,
      true,
    )
  }

  #finalResponse() {
    if (typeof this.#finalText === 'string' && this.#finalText.trim()) return this.#finalText.trim()
    const pending = this.#pendingAssistantText.at(-1)
    return typeof pending === 'string' && pending.trim() ? pending.trim() : null
  }

  #abort = () => {
    if (this.#settled) return
    if (this.#sessionId) {
      void this.#request('droid.interrupt_session', {}).catch(() => {})
    }
    this.#fail(new DroidExecError(
      'run_cancelled',
      'Run stopped by user. The provider process was terminated.',
      499,
      false,
    ))
  }

  #request(method, params) {
    if (this.#settled) {
      return Promise.reject(new DroidExecError(
        'droid_exec_disconnected',
        'Factory Droid is no longer connected.',
        502,
        !this.#turnStarted,
      ))
    }
    const id = String(this.#nextRequestId++)
    return new Promise((resolve, reject) => {
      this.#requests.set(id, { resolve, reject, method })
      const line = `${JSON.stringify(droidRequestEnvelope(id, method, params))}\n`
      this.#child.stdin.write(line, 'utf8', (error) => {
        if (!error) return
        this.#requests.delete(id)
        reject(new DroidExecError(
          'droid_exec_disconnected',
          `Factory Droid could not receive ${method}.`,
          502,
          !this.#turnStarted,
        ))
      })
    })
  }

  #respond(id, result) {
    if (this.#settled) return
    this.#child.stdin.write(`${JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      factoryApiVersion: FACTORY_API_VERSION,
      type: 'response',
      id,
      result,
    })}\n`)
  }

  #handleLine(line) {
    this.#touch()
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // Droid frames one JSON value per line; a partial or non-JSON line is not
      // recoverable protocol state and must not be guessed at.
      this.#fail(new DroidExecError(
        'invalid_cli_output',
        'Factory Droid produced output Ensync Host could not verify as a JSON-RPC message.',
        502,
        false,
      ))
      return
    }
    if (!message || typeof message !== 'object') return

    if (message.type === 'response') {
      const pending = this.#requests.get(message.id)
      if (!pending) return
      this.#requests.delete(message.id)
      if (message.error) {
        pending.reject(new DroidExecError(
          'droid_exec_request_failed',
          typeof message.error.message === 'string'
            ? message.error.message
            : `Factory Droid rejected ${pending.method}.`,
          409,
          !this.#turnStarted,
        ))
        return
      }
      pending.resolve(message.result)
      return
    }

    if (message.type === 'request') {
      if (message.method === 'droid.ask_user' && this.#questions) {
        this.#askUser(message)
        return
      }
      this.#declineServerRequest(message)
      return
    }

    if (message.type === 'notification' && message.method === 'droid.session_notification') {
      this.#handleNotification(message.params?.notification)
    }
  }

  /**
   * Puts a `droid.ask_user` questionnaire to the person and answers Droid with
   * their words. The turn is genuinely blocked meanwhile, so the inactivity
   * watchdog is held: waiting on a human is not a hung CLI. If the run ends
   * first, the registry resolves the question as cancelled and Droid still gets
   * the documented `{ cancelled: true, answers: [] }` outcome.
   */
  #askUser(message) {
    const normalized = normalizeDroidQuestions(message.params)
    if (!normalized) {
      this.#declineServerRequest(message)
      return
    }
    const askedAt = new Date().toISOString()
    const { id, questions, answered } = this.#questions.ask({
      provider: 'droid',
      questions: normalized.questions,
      toolCallId: normalized.toolCallId,
      askedAt,
    })
    this.onEvent?.(providerQuestionEvent('droid', id, questions, askedAt))
    this.#holdInactivity()
    void answered.then((resolution) => {
      this.#releaseInactivity()
      this.onEvent?.(providerQuestionResolvedEvent('droid', id, resolution, new Date().toISOString()))
      this.#respond(message.id, droidAskUserResult(resolution))
    })
  }

  answerQuestion(questionId, input) {
    if (!this.#questions) return null
    return this.#questions.answer(questionId, input)
  }

  pendingQuestions() {
    return this.#questions ? this.#questions.list() : []
  }

  // Droid asks the client to resolve tool permissions and questionnaires.
  // Ensync cannot review permissions safely yet, so it declines them with the
  // provider's own documented outcome values rather than leaving the turn
  // hanging. Questionnaires reach the person instead; see #askUser.
  #declineServerRequest(message) {
    if (message.method === 'droid.request_permission') {
      this.#respond(message.id, { selectedOption: 'cancel' })
    } else if (message.method === 'droid.ask_user') {
      this.#respond(message.id, { cancelled: true, answers: [] })
    } else {
      this.#child.stdin.write(`${JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        factoryApiVersion: FACTORY_API_VERSION,
        type: 'response',
        id: message.id,
        error: { code: -32601, message: 'Unsupported Ensync client request.' },
      })}\n`)
    }
    this.onEvent?.({
      type: 'notice',
      code: 'provider_request_declined',
      message: `Factory Droid requested interactive input (${message.method}); Ensync declined it safely.`,
      at: new Date().toISOString(),
    })
  }

  #handleNotification(notification) {
    if (!notification || typeof notification !== 'object' || typeof notification.type !== 'string') return
    this.#notifications.push(notification)

    if (notification.type === 'settings_updated') {
      this.#rememberSettings(notification.settings)
      return
    }
    if (notification.type === 'session_token_usage_changed') {
      this.#usage = usageFrom(notification.tokenUsage) ?? this.#usage
      return
    }
    if (notification.type === 'create_message') {
      this.#handleMessage(notification.message)
      return
    }
    if (notification.type === 'tool_call') {
      // Text that precedes tool work is provider-authored progress, not the
      // final answer, so it is released as a note exactly once.
      this.#flushNotes()
      const toolName = notification.toolUse?.name ?? notification.toolUse?.toolName
      if (typeof toolName === 'string' && toolName) {
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
    if (notification.type === 'agent_turn_completed') {
      this.#settled = true
      this.#resolveDone(notification)
    }
  }

  #handleMessage(message) {
    if (message?.role !== 'assistant') return
    if (typeof message.modelId === 'string' && message.modelId.trim()) this.#model = message.modelId.trim()
    const text = assistantMessageText(message)
    if (!text) return
    this.#pendingAssistantText.push(truncate(text))
    this.#finalText = truncate(text)
  }

  #flushNotes() {
    for (const text of this.#pendingAssistantText) {
      this.onEvent?.({
        type: 'note',
        provider: 'droid',
        text,
        redacted: false,
        at: new Date().toISOString(),
      })
    }
    if (this.#pendingAssistantText.length > 0) this.#finalText = null
    this.#pendingAssistantText = []
  }

  #holdInactivity() {
    this.#inactivityHeld = true
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer)
    this.#inactivityTimer = null
  }

  #releaseInactivity() {
    this.#inactivityHeld = false
    this.#touch()
  }

  #touch() {
    if (this.#settled || this.#inactivityHeld || !Number.isFinite(this.inactivityTimeoutMs)) return
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer)
    this.#inactivityTimer = setTimeout(() => this.#fail(new DroidExecError(
      'run_timed_out',
      "Factory Droid produced no protocol activity before Ensync Host's inactivity limit and was stopped. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.inactivityTimeoutMs)
    this.#inactivityTimer.unref?.()
  }

  #fail(error) {
    if (this.#settled) return
    this.#settled = true
    this.#questions?.closeAll()
    this.#rejectDone(error)
    for (const pending of this.#requests.values()) pending.reject(error)
    this.#requests.clear()
    this.#terminate()
  }

  #finishProcess() {
    this.#questions?.closeAll()
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

export class DroidExecRunner {
  #sessions = new Map()
  #spawnProcess
  #inactivityTimeoutMs
  #hardTimeoutMs

  constructor(options = {}) {
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs
    this.#hardTimeoutMs = options.hardTimeoutMs
  }

  async run(input, options = {}) {
    const session = new DroidExecSession(input, {
      ...options,
      // Only a run bound to a retained job can be answered later, so only that
      // run is allowed to ask.
      questionsEnabled: typeof input?.id === 'string' && Boolean(input.id),
      spawnProcess: this.#spawnProcess,
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    })
    if (typeof input?.id !== 'string' || !input.id) return session.run()
    if (this.#sessions.has(input.id)) {
      throw new DroidExecError(
        'chat_job_conflict',
        'That retained job already owns a Factory Droid session.',
        409,
        true,
      )
    }
    this.#sessions.set(input.id, session)
    try {
      return await session.run()
    } finally {
      this.#sessions.delete(input.id)
    }
  }

  hasSession(id) {
    return this.#sessions.has(id)
  }

  answerQuestion(id, questionId, input) {
    const session = this.#sessions.get(id)
    if (!session) {
      throw new DroidExecError(
        'question_not_found',
        'That retained job has no active Factory Droid session, so the answer was not delivered.',
        409,
        false,
      )
    }
    return session.answerQuestion(questionId, input)
  }

  pendingQuestions(id) {
    return this.#sessions.get(id)?.pendingQuestions() ?? []
  }
}

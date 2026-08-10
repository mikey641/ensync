import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { extname } from 'node:path'
import { commandInvocation } from './command.mjs'
import { finalCodexResponse } from './codex-response.mjs'
import { JsonEventRepairTracker } from './json-event-repair.mjs'

const CODEX_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp'])
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const MAX_STDERR_CHARACTERS = 256 * 1024

export class CodexLiveTurnError extends Error {
  constructor(code, message, status = 502, safeToRetry = false) {
    super(message)
    this.name = 'CodexLiveTurnError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

function asProtocolError(error, fallbackCode, fallbackMessage, safeToRetry = false) {
  if (error instanceof CodexLiveTurnError) return error
  return new CodexLiveTurnError(fallbackCode, fallbackMessage, 502, safeToRetry)
}

function userInput(prompt, attachmentPaths = []) {
  return [
    { type: 'text', text: prompt, text_elements: [] },
    ...attachmentPaths
      .filter((path) => CODEX_IMAGE_EXTENSIONS.has(extname(path).toLowerCase()))
      .map((path) => ({ type: 'localImage', path })),
  ]
}

function usageFromNotification(value) {
  const usage = value?.last
  if (!usage || typeof usage !== 'object') return null
  const integer = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null
  const inputTokens = integer(usage.inputTokens)
  const outputTokens = integer(usage.outputTokens)
  const cachedInputTokens = integer(usage.cachedInputTokens)
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null
  return { source: 'cli', inputTokens, outputTokens, cachedInputTokens }
}

function serverRequestRejection(message) {
  const reason = 'Ensync live steering cannot review interactive provider requests yet.'
  if (message.method === 'item/commandExecution/requestApproval') {
    return { decision: 'decline' }
  }
  if (message.method === 'item/fileChange/requestApproval') {
    return { decision: 'decline' }
  }
  if (message.method === 'execCommandApproval' || message.method === 'applyPatchApproval') {
    return { decision: { denied: { rejection: reason } } }
  }
  if (message.method === 'item/tool/requestUserInput') return { answers: {} }
  if (message.method === 'mcpServer/elicitation/request') {
    return { action: 'decline', content: null, _meta: null }
  }
  if (message.method === 'item/tool/call') {
    return { contentItems: [{ type: 'inputText', text: reason }], success: false }
  }
  return null
}

class CodexLiveSession {
  #child
  #reader
  #requests = new Map()
  #nextRequestId = 1
  #threadId = null
  #turnId = null
  #activatedTurnId = null
  #turnStarted = false
  #settled = false
  #readySettled = false
  #agentMessages = []
  #agentMessagePhases = new Map()
  #model = null
  #usage = null
  #stderr = ''
  #hardTimer = null
  #inactivityTimer = null
  #forceKillTimer = null
  #resolveDone
  #rejectDone
  #resolveReady
  #rejectReady
  #done
  #ready
  #eventRepair = new JsonEventRepairTracker()

  constructor(input, options = {}) {
    this.id = input.id
    this.input = input
    this.onEvent = options.onEvent
    this.signal = options.signal
    this.spawnProcess = options.spawnProcess ?? spawn
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
    this.hardTimeoutMs = options.hardTimeoutMs ?? null
    this.#done = new Promise((resolve, reject) => {
      this.#resolveDone = resolve
      this.#rejectDone = reject
    })
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    // Either promise can be rejected before its normal await point (for
    // example, when app-server fails during initialization).
    void this.#done.catch(() => {})
    void this.#ready.catch(() => {})
  }

  async run() {
    const startedAt = Date.now()
    const invocation = commandInvocation(this.input.executable, ['app-server'], this.input.env)
    this.#child = this.spawnProcess(invocation.executable, invocation.args, {
      cwd: this.input.projectPath,
      env: this.input.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.onEvent?.({
      type: 'started',
      provider: 'codex',
      cwd: this.input.projectPath,
      command: `${this.input.executable} app-server`,
      at: new Date(startedAt).toISOString(),
    })

    this.#reader = createInterface({ input: this.#child.stdout })
    this.#reader.on('line', (line) => this.#handleLine(line))
    this.#child.stderr.on('data', (chunk) => {
      this.#touch()
      this.#stderr = `${this.#stderr}${chunk.toString('utf8')}`.slice(0, MAX_STDERR_CHARACTERS)
    })
    this.#child.on('error', (error) => {
      this.#fail(new CodexLiveTurnError(
        'run_start_failed',
        `Codex app-server could not be started: ${error.message}`,
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
      this.#fail(new CodexLiveTurnError(
        'codex_live_turn_disconnected',
        `Codex app-server ended before the active turn completed.${detail}`,
        502,
        !this.#turnStarted,
      ))
    })
    this.#child.stdin.on('error', () => {
      // The close/error event is authoritative; a concurrent exit can close stdin first.
    })

    this.#touch()
    if (Number.isFinite(this.hardTimeoutMs) && this.hardTimeoutMs > 0) {
      this.#hardTimer = setTimeout(() => this.#fail(new CodexLiveTurnError(
        'run_timed_out',
        "Codex reached Ensync Host's explicit run limit and was stopped. Partial work may exist; review the project before retrying.",
        504,
        false,
      )), this.hardTimeoutMs)
      this.#hardTimer.unref?.()
    }
    this.signal?.addEventListener('abort', this.#abort, { once: true })
    if (this.signal?.aborted) this.#abort()

    try {
      await this.#request('initialize', {
        clientInfo: { name: 'ensync', title: 'Ensync', version: '0.1.0' },
        capabilities: null,
      })
      this.#notify('initialized')
      const threadResponse = this.input.sessionId
        ? await this.#request('thread/resume', {
            threadId: this.input.sessionId,
            cwd: this.input.projectPath,
            ...(this.input.model ? { model: this.input.model } : {}),
          })
        : await this.#request('thread/start', {
            cwd: this.input.projectPath,
            ...(this.input.model ? { model: this.input.model } : {}),
          })
      this.#threadId = threadResponse?.thread?.id
      this.#model = typeof threadResponse?.model === 'string' ? threadResponse.model : null
      if (typeof this.#threadId !== 'string' || !this.#threadId) {
        throw new CodexLiveTurnError(
          'invalid_cli_output',
          'Codex app-server did not return a valid thread ID.',
          502,
          true,
        )
      }
      const turnResponse = await this.#request('turn/start', {
        threadId: this.#threadId,
        input: userInput(this.input.prompt, this.input.attachmentPaths),
        cwd: this.input.projectPath,
        ...(this.input.model ? { model: this.input.model } : {}),
        ...(this.input.effort ? { effort: this.input.effort } : {}),
      })
      const startedTurnId = turnResponse?.turn?.id
      if (typeof startedTurnId !== 'string' || !startedTurnId) {
        throw new CodexLiveTurnError(
          'invalid_cli_output',
          'Codex app-server did not return a valid active turn ID.',
          502,
          true,
        )
      }
      if (this.#activatedTurnId && this.#activatedTurnId !== startedTurnId) {
        throw new CodexLiveTurnError(
          'invalid_cli_output',
          'Codex app-server started a different turn than the one it reported active.',
          502,
          false,
        )
      }
      this.#turnId = startedTurnId
      this.#turnStarted = true
      this.#resolveReadyIfActive()
      const completedTurn = await this.#done
      if (completedTurn?.status !== 'completed') {
        throw new CodexLiveTurnError(
          completedTurn?.status === 'interrupted' ? 'run_cancelled' : 'cli_failed',
          completedTurn?.error?.message || `Codex ended the active turn with status ${completedTurn?.status ?? 'unknown'}.`,
          completedTurn?.status === 'interrupted' ? 499 : 502,
          false,
        )
      }
      const response = finalCodexResponse([
        ...this.#agentMessages,
        ...(completedTurn.items ?? []),
      ])
      if (!response) {
        throw new CodexLiveTurnError(
          'empty_cli_response',
          'Codex finished without a verifiable final agent response.',
          502,
          false,
        )
      }
      return {
        provider: 'codex',
        projectPath: this.input.projectPath,
        response,
        sessionId: this.#threadId,
        model: this.#model,
        requestedModel: this.input.model ?? null,
        requestedEffort: this.input.effort ?? null,
        usage: this.#usage,
        outputRecovery: this.#eventRepair.recovery,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      }
    } catch (error) {
      throw asProtocolError(
        error,
        'codex_live_turn_failed',
        'Codex live-turn execution failed before Ensync received a verified completion.',
        !this.#turnStarted,
      )
    } finally {
      this.#finishProcess()
    }
  }

  async steer(prompt, attachmentPaths) {
    if (this.#settled) {
      throw new CodexLiveTurnError(
        'live_steer_unavailable',
        'The Codex turn already finished, so this message was not delivered to it.',
        409,
        true,
      )
    }
    await this.#ready
    if (this.#settled || !this.#threadId || !this.#turnId) {
      throw new CodexLiveTurnError(
        'live_steer_unavailable',
        'There is no active Codex turn to steer. The message was not delivered.',
        409,
        true,
      )
    }
    try {
      const result = await this.#request('turn/steer', {
        threadId: this.#threadId,
        expectedTurnId: this.#turnId,
        input: userInput(prompt, attachmentPaths),
      })
      if (result?.turnId !== this.#turnId) {
        throw new CodexLiveTurnError(
          'live_steer_unconfirmed',
          'Codex did not confirm which active turn received the instruction.',
          502,
          false,
        )
      }
      this.onEvent?.({
        type: 'notice',
        message: 'New instruction delivered to the active Codex turn.',
        at: new Date().toISOString(),
      })
      return { turnId: this.#turnId }
    } catch (error) {
      if (error instanceof CodexLiveTurnError) throw error
      throw new CodexLiveTurnError(
        'live_steer_unconfirmed',
        'Ensync could not confirm whether Codex received the live instruction. It was not queued again to avoid duplicate execution.',
        502,
        false,
      )
    }
  }

  #abort = () => {
    if (this.#settled) return
    if (this.#threadId && this.#turnId) {
      void this.#request('turn/interrupt', { threadId: this.#threadId, turnId: this.#turnId }).catch(() => {})
    }
    this.#fail(new CodexLiveTurnError(
      'run_cancelled',
      'Run stopped by user. The provider process was terminated.',
      499,
      false,
    ))
  }

  #request(method, params) {
    if (this.#settled) {
      return Promise.reject(new CodexLiveTurnError(
        'codex_live_turn_disconnected',
        'Codex app-server is no longer connected.',
        502,
        !this.#turnStarted,
      ))
    }
    const id = this.#nextRequestId++
    return new Promise((resolve, reject) => {
      this.#requests.set(id, { resolve, reject, method })
      const line = `${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`
      this.#child.stdin.write(line, 'utf8', (error) => {
        if (!error) return
        this.#requests.delete(id)
        reject(new CodexLiveTurnError(
          method === 'turn/steer' ? 'live_steer_unavailable' : 'codex_live_turn_disconnected',
          `Codex app-server could not receive ${method}.`,
          502,
          method === 'turn/steer' || !this.#turnStarted,
        ))
      })
    })
  }

  #notify(method, params) {
    if (!this.#settled) {
      this.#child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`)
    }
  }

  #handleLine(line) {
    this.#touch()
    let message
    try {
      message = this.#eventRepair.decode(line, { allowRepair: true })
    } catch {
      this.#fail(new CodexLiveTurnError(
        'invalid_cli_output',
        'Ensync Host tried a bounded repair of Codex app-server output but could not recover a verifiable protocol stream.',
        502,
        false,
      ))
      return
    }
    if (!message) return

    if (message.id != null && !message.method) {
      const pending = this.#requests.get(message.id)
      if (!pending) return
      this.#requests.delete(message.id)
      if (message.error) {
        const detail = typeof message.error.message === 'string' ? message.error.message : 'Codex rejected the request.'
        pending.reject(new CodexLiveTurnError(
          pending.method === 'turn/steer' ? 'live_steer_unavailable' : 'codex_live_turn_request_failed',
          detail,
          409,
          pending.method === 'turn/steer' || !this.#turnStarted,
        ))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.id != null && message.method) {
      const rejection = serverRequestRejection(message)
      if (rejection) this.#child.stdin.write(`${JSON.stringify({ id: message.id, result: rejection })}\n`)
      else this.#child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported Ensync client request.' } })}\n`)
      this.onEvent?.({
        type: 'notice',
        message: `Codex requested interactive input (${message.method}); Ensync declined it safely.`,
        at: new Date().toISOString(),
      })
      return
    }

    const params = message.params
    if (
      this.#threadId
      && typeof params?.threadId === 'string'
      && params.threadId !== this.#threadId
    ) return

    if (message.method === 'turn/started' && params?.turn?.id) {
      if (!this.#turnId) this.#turnId = params.turn.id
      this.#turnStarted = true
      this.#resolveReadyIfActive()
    } else if (message.method === 'item/completed' && params?.item?.type === 'agentMessage') {
      const phase = params.item.phase ?? this.#agentMessagePhases.get(params.item.id) ?? null
      this.#agentMessagePhases.delete(params.item.id)
      if (typeof params.item.text === 'string' && params.item.text.trim()) {
        this.#agentMessages.push(params.item)
        if (phase === 'commentary') {
          this.onEvent?.({
            type: 'note',
            provider: 'codex',
            text: params.item.text.trim(),
            redacted: false,
            at: new Date().toISOString(),
          })
        }
      }
    } else if (message.method === 'thread/tokenUsage/updated') {
      this.#usage = usageFromNotification(params?.tokenUsage) ?? this.#usage
    } else if (message.method === 'model/rerouted' && typeof params?.toModel === 'string') {
      this.#model = params.toModel
    } else if (message.method === 'turn/completed' && params?.turn?.id === this.#turnId) {
      this.#settled = true
      this.#rejectReadyOnce(new CodexLiveTurnError(
        'live_steer_unavailable',
        'The Codex turn already finished, so this message was not delivered to it.',
        409,
        true,
      ))
      this.#resolveDone(params.turn)
    } else if (message.method === 'item/commandExecution/outputDelta' && typeof params?.delta === 'string') {
      this.onEvent?.({
        type: 'output',
        stream: 'stdout',
        text: params.delta,
        redacted: false,
        at: new Date().toISOString(),
      })
    } else if (message.method === 'item/started') {
      if (params?.item?.type === 'agentMessage' && typeof params.item.id === 'string') {
        this.#agentMessagePhases.set(params.item.id, params.item.phase ?? null)
      } else if (params?.item?.type === 'commandExecution') {
        this.onEvent?.({
          type: 'output',
          stream: 'stdout',
          text: `\n> ${params.item.command}\n`,
          redacted: false,
          at: new Date().toISOString(),
        })
      }
    }
  }

  #touch() {
    if (this.#settled || !Number.isFinite(this.inactivityTimeoutMs)) return
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer)
    this.#inactivityTimer = setTimeout(() => this.#fail(new CodexLiveTurnError(
      'run_timed_out',
      "Codex produced no protocol activity before Ensync Host's inactivity limit and was stopped. Partial work may exist; review the project before retrying.",
      504,
      false,
    )), this.inactivityTimeoutMs)
    this.#inactivityTimer.unref?.()
  }

  // Steering readiness requires the turn identity to be fully established:
  // the turn/start response and the turn/started activation notification must
  // both have arrived and agree before any turn/steer can be trusted.
  #resolveReadyIfActive() {
    if (this.#readySettled
      || this.#settled
      || !this.#threadId
      || !this.#turnId
      || this.#activatedTurnId !== this.#turnId) return
    this.#readySettled = true
    this.#resolveReady({ threadId: this.#threadId, turnId: this.#turnId })
  }

  #rejectReadyOnce(error) {
    if (this.#readySettled) return
    this.#readySettled = true
    this.#rejectReady(error)
  }

  #fail(error) {
    if (this.#settled) return
    this.#settled = true
    this.#rejectReadyOnce(error)
    this.#rejectDone(error)
    for (const pending of this.#requests.values()) pending.reject(error)
    this.#requests.clear()
    this.#terminate()
  }

  #finishProcess() {
    if (this.#hardTimer) clearTimeout(this.#hardTimer)
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
    if (!this.#forceKillTimer) {
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
}

export class CodexLiveTurnRunner {
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
    if (typeof input?.id !== 'string' || !input.id) {
      throw new CodexLiveTurnError('invalid_chat_job', 'A live Codex turn requires a retained job ID.', 400, true)
    }
    if (this.#sessions.has(input.id)) {
      throw new CodexLiveTurnError('chat_job_conflict', 'That retained job already owns a Codex live turn.', 409, true)
    }
    const session = new CodexLiveSession(input, {
      ...options,
      spawnProcess: this.#spawnProcess,
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    })
    this.#sessions.set(input.id, session)
    try {
      return await session.run()
    } finally {
      this.#sessions.delete(input.id)
    }
  }

  async steer(id, prompt, attachmentPaths = []) {
    const session = this.#sessions.get(id)
    if (!session) {
      throw new CodexLiveTurnError(
        'live_steer_unavailable',
        'That retained job has no active Codex turn. The message was not delivered.',
        409,
        true,
      )
    }
    return session.steer(prompt, attachmentPaths)
  }
}

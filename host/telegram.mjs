import {
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  validateRemoteProjectPath,
  validateSshHostname,
  validateSshPort,
  validateSshUsername,
} from './remote-ssh.mjs'

const TELEGRAM_API_ROOT = 'https://api.telegram.org'
const DEFAULT_PAIRING_TTL_MS = 10 * 60_000
const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000
const DEFAULT_POLL_TIMEOUT_SECONDS = 25
const MAX_TASK_TEXT_LENGTH = 3_000
const MAX_DELIVERY_TEXT_LENGTH = 4_000
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const PROVIDER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const BOT_TOKEN_PATTERN = /^\d{5,20}:[a-zA-Z0-9_-]{20,}$/

export class TelegramBridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'TelegramBridgeError'
    this.code = code
    this.status = status
  }
}

function asTelegramId(value) {
  return Number.isSafeInteger(value) ? String(value) : null
}

function displayName(user) {
  const name = [user?.first_name, user?.last_name]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ')
    .trim()
  return name || (typeof user?.username === 'string' ? `@${user.username}` : 'Telegram user')
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TelegramBridgeError('invalid_task_context', `${label} is missing or invalid.`)
  }
  return value
}

export function validateTelegramTaskContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TelegramBridgeError('invalid_task_context', 'A selected Ensync task context is required.')
  }
  const provider = typeof context.provider === 'string' ? context.provider.trim() : ''
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new TelegramBridgeError('invalid_task_context', 'The selected provider is missing or invalid.')
  }
  const projectLabel = typeof context.projectLabel === 'string' && context.projectLabel.trim()
    ? context.projectLabel.trim().slice(0, 160)
    : requiredId(context.projectId, 'Project ID')
  let executionTarget
  if (context.executionTarget != null) {
    if (context.executionTarget?.kind === 'local') {
      executionTarget = { kind: 'local' }
    } else if (context.executionTarget?.kind === 'ssh') {
      const connection = context.executionTarget.connection
      if (
        !connection
        || typeof connection !== 'object'
        || typeof connection.hostname !== 'string'
        || typeof connection.username !== 'string'
        || !Number.isInteger(connection.port)
        || typeof connection.projectPath !== 'string'
        || (connection.identityFile != null && typeof connection.identityFile !== 'string')
      ) {
        throw new TelegramBridgeError('invalid_task_context', 'The selected SSH execution target is invalid.')
      }
      if (
        connection.identityFile != null
        && (!isAbsolute(connection.identityFile) || /[\0\r\n]/.test(connection.identityFile))
      ) {
        throw new TelegramBridgeError('invalid_task_context', 'The selected SSH identity-file path is invalid.')
      }
      let validatedConnection
      try {
        validatedConnection = {
          hostname: validateSshHostname(connection.hostname),
          username: validateSshUsername(connection.username),
          port: validateSshPort(connection.port),
          identityFile: connection.identityFile ?? null,
          projectPath: validateRemoteProjectPath(connection.projectPath),
        }
      } catch {
        throw new TelegramBridgeError('invalid_task_context', 'The selected SSH execution target is invalid.')
      }
      executionTarget = {
        kind: 'ssh',
        connection: validatedConnection,
      }
    } else {
      throw new TelegramBridgeError('invalid_task_context', 'The selected execution target is invalid.')
    }
  }
  return {
    projectId: requiredId(context.projectId, 'Project ID'),
    projectLabel,
    projectPath: typeof context.projectPath === 'string' && context.projectPath.trim()
      ? context.projectPath.trim()
      : null,
    conversationId: requiredId(context.conversationId, 'Conversation ID'),
    provider,
    ...(executionTarget ? { executionTarget } : {}),
  }
}

function telegramAccount(user) {
  return {
    id: asTelegramId(user?.id),
    username: typeof user?.username === 'string' ? user.username : null,
    displayName: displayName(user),
  }
}

function publicBot(bot) {
  if (!bot) return null
  return {
    id: bot.id,
    username: bot.username,
    displayName: bot.displayName,
  }
}

function formatApproval(approval) {
  const runtime = approval.context.executionTarget?.kind === 'ssh'
    ? `SSH ${approval.context.executionTarget.connection.username}@${approval.context.executionTarget.connection.hostname}:${approval.context.executionTarget.connection.port}`
    : 'This Ensync Host'
  return [
    'Approval required',
    `Project: ${approval.context.projectLabel} (${approval.context.projectId})`,
    `Conversation: ${approval.context.conversationId}`,
    `Provider: ${approval.context.provider}`,
    `Runtime: ${runtime}`,
    `Action: ${approval.prompt}`,
    `Expires: ${new Date(approval.expiresAt).toISOString()}`,
  ].join('\n')
}

function splitDelivery(text) {
  const chunks = []
  let remaining = text
  while (remaining.length > MAX_DELIVERY_TEXT_LENGTH) {
    let boundary = remaining.lastIndexOf('\n', MAX_DELIVERY_TEXT_LENGTH)
    if (boundary < MAX_DELIVERY_TEXT_LENGTH / 2) boundary = MAX_DELIVERY_TEXT_LENGTH
    chunks.push(remaining.slice(0, boundary))
    remaining = remaining.slice(boundary).replace(/^\n/, '')
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * In-memory Telegram Bot API transport for Ensync Host.
 *
 * Tokens never leave this instance after setup. Persistence must be added only
 * through a real OS credential-store adapter; this class deliberately has no
 * plaintext file fallback.
 *
 * `chatRunner.run()` is the sole execution boundary. It must run the selected
 * Ensync conversation through the normal subscription CLI router and preserve
 * that router's pre-mutation-only fallback rule.
 */
export class TelegramBridgeService {
  #fetch
  #now
  #randomBytes
  #autoPoll
  #pairingTtlMs
  #approvalTtlMs
  #pollTimeoutSeconds
  #chatRunner
  #resolveTaskContext
  #token = null
  #bot = null
  #pairing = null
  #connection = null
  #taskContext = null
  #approvals = new Map()
  #callbackSecret
  #offset = 0
  #pollAbort = null
  #pollPromise = null
  #lastError = null

  constructor(options = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    if (typeof this.#fetch !== 'function') {
      throw new Error('TelegramBridgeService requires a fetch implementation.')
    }
    this.#now = options.now ?? Date.now
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes
    this.#autoPoll = options.autoPoll !== false
    this.#pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS
    this.#approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    this.#pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS
    this.#chatRunner = options.chatRunner ?? null
    this.#resolveTaskContext = options.resolveTaskContext ?? null
    this.#callbackSecret = this.#randomBytes(32)
  }

  async #api(method, payload = {}, options = {}) {
    if (!this.#token) {
      throw new TelegramBridgeError('not_configured', 'Telegram is not configured.', 409)
    }
    let response
    try {
      response = await this.#fetch(
        `${TELEGRAM_API_ROOT}/bot${this.#token}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: options.signal,
        },
      )
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError') throw error
      throw new TelegramBridgeError(
        'telegram_unreachable',
        `Telegram ${method} could not be reached.`,
        502,
      )
    }

    let body
    try {
      body = await response.json()
    } catch {
      throw new TelegramBridgeError(
        'telegram_invalid_response',
        `Telegram ${method} returned an invalid response.`,
        502,
      )
    }
    if (!response.ok || body?.ok !== true) {
      throw new TelegramBridgeError(
        'telegram_rejected',
        `Telegram rejected ${method}${Number.isInteger(body?.error_code) ? ` (${body.error_code})` : ''}.`,
        response.status === 401 ? 401 : 502,
      )
    }
    return body.result
  }

  async startPairing(botToken) {
    const token = typeof botToken === 'string' ? botToken.trim() : ''
    if (!BOT_TOKEN_PATTERN.test(token)) {
      throw new TelegramBridgeError('invalid_token', 'Enter a valid token issued by BotFather.')
    }
    if (this.#connection) {
      throw new TelegramBridgeError(
        'already_connected',
        'Disconnect the current Telegram account before pairing another bot.',
        409,
      )
    }
    if (this.#pairing && this.#pairing.expiresAt > this.#now()) {
      throw new TelegramBridgeError(
        'pairing_in_progress',
        'A Telegram pairing session is already active.',
        409,
      )
    }

    // Stop any expired session's poll before changing the token used by #api.
    // This prevents an update from the previous bot being processed while a new
    // token is temporarily installed for getMe verification.
    await this.stopPolling()
    this.#pairing = null

    const previousToken = this.#token
    this.#token = token
    let me
    try {
      me = await this.#api('getMe')
    } catch (error) {
      this.#token = previousToken
      throw error
    }
    const botId = asTelegramId(me?.id)
    if (!botId || me?.is_bot !== true || typeof me?.username !== 'string' || !me.username.trim()) {
      this.#token = previousToken
      throw new TelegramBridgeError(
        'invalid_bot_identity',
        'Telegram did not return a verifiable bot identity.',
        502,
      )
    }
    this.#token = token
    this.#bot = { id: botId, username: me.username, displayName: displayName(me) }
    this.#connection = null
    this.#approvals.clear()
    this.#offset = 0
    this.#lastError = null
    const createdAt = this.#now()
    this.#pairing = {
      id: base64url(this.#randomBytes(12)),
      code: base64url(this.#randomBytes(6)).toUpperCase(),
      createdAt,
      expiresAt: createdAt + this.#pairingTtlMs,
    }
    if (this.#autoPoll) this.startPolling()

    return {
      pairingId: this.#pairing.id,
      code: this.#pairing.code,
      expiresAt: new Date(this.#pairing.expiresAt).toISOString(),
      bot: publicBot(this.#bot),
      tokenStorage: 'memory_only',
      encryptedCredentialStorage: false,
    }
  }

  setTaskContext(context) {
    this.#taskContext = validateTelegramTaskContext(context)
    return { ...this.#taskContext }
  }

  clearTaskContext() {
    this.#taskContext = null
  }

  async #currentTaskContext() {
    const resolved = typeof this.#resolveTaskContext === 'function'
      ? await this.#resolveTaskContext({ connectionId: this.#connection?.id ?? null })
      : this.#taskContext
    return validateTelegramTaskContext(resolved)
  }

  status() {
    this.#expireApprovals()
    if (this.#pairing && this.#pairing.expiresAt <= this.#now()) this.#pairing = null
    const common = {
      bot: publicBot(this.#bot),
      tokenStorage: this.#token ? 'memory_only' : 'none',
      encryptedCredentialStorage: false,
      lastError: this.#lastError,
      pendingApprovals: [...this.#approvals.values()]
        .filter((approval) => approval.status === 'pending')
        .map((approval) => ({
          id: approval.id,
          projectId: approval.context.projectId,
          projectLabel: approval.context.projectLabel,
          conversationId: approval.context.conversationId,
          provider: approval.context.provider,
          action: approval.prompt,
          expiresAt: new Date(approval.expiresAt).toISOString(),
        })),
    }
    if (this.#connection) {
      return {
        ...common,
        state: 'connected',
        connectionId: this.#connection.id,
        confirmedAt: new Date(this.#connection.confirmedAt).toISOString(),
        telegramAccount: { ...this.#connection.account },
        chatId: this.#connection.chatId,
      }
    }
    if (this.#pairing) {
      return {
        ...common,
        state: 'pairing',
        pairingId: this.#pairing.id,
        code: this.#pairing.code,
        expiresAt: new Date(this.#pairing.expiresAt).toISOString(),
      }
    }
    return { ...common, state: this.#token ? 'verified' : 'disconnected' }
  }

  async disconnect() {
    await this.stopPolling()
    this.#token = null
    this.#bot = null
    this.#pairing = null
    this.#connection = null
    this.#taskContext = null
    this.#approvals.clear()
    this.#offset = 0
    this.#lastError = null
    return this.status()
  }

  // This revokes the local Ensync binding and forgets the in-memory token. Bot
  // token rotation itself remains a BotFather operation and is never simulated.
  async revokeLocalConnection() {
    const revokedAt = new Date(this.#now()).toISOString()
    await this.disconnect()
    return { state: 'disconnected', revokedAt, botTokenRevoked: false }
  }

  async sendMessage(text) {
    if (!this.#connection) {
      throw new TelegramBridgeError('not_connected', 'Pair a Telegram account before sending.', 409)
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new TelegramBridgeError('invalid_message', 'A non-empty Telegram message is required.')
    }
    const chunks = splitDelivery(text.trim())
    const deliveries = []
    for (const chunk of chunks) {
      const result = await this.#api('sendMessage', {
        chat_id: this.#connection.chatId,
        text: chunk,
      })
      deliveries.push({
        messageId: Number.isSafeInteger(result?.message_id) ? result.message_id : null,
        sentAt: new Date(this.#now()).toISOString(),
      })
    }
    return { connectionId: this.#connection.id, deliveries }
  }

  startPolling() {
    if (!this.#token || this.#pollPromise) return this.#pollPromise
    const controller = new AbortController()
    this.#pollAbort = controller
    this.#pollPromise = this.#pollLoop(controller.signal).finally(() => {
      if (this.#pollAbort === controller) this.#pollAbort = null
      this.#pollPromise = null
    })
    return this.#pollPromise
  }

  async stopPolling() {
    this.#pollAbort?.abort()
    await this.#pollPromise?.catch(() => undefined)
  }

  async pollOnce(options = {}) {
    const updates = await this.#api('getUpdates', {
      offset: this.#offset,
      timeout: options.timeoutSeconds ?? 0,
      allowed_updates: ['message', 'callback_query'],
    }, { signal: options.signal })
    if (!Array.isArray(updates)) {
      throw new TelegramBridgeError('telegram_invalid_response', 'Telegram returned invalid updates.', 502)
    }
    for (const update of updates) {
      if (Number.isSafeInteger(update?.update_id)) {
        this.#offset = Math.max(this.#offset, update.update_id + 1)
      }
      await this.processUpdate(update)
    }
    return updates.length
  }

  async #pollLoop(signal) {
    while (!signal.aborted && this.#token) {
      try {
        await this.pollOnce({ timeoutSeconds: this.#pollTimeoutSeconds, signal })
        this.#lastError = null
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') break
        this.#lastError = error instanceof TelegramBridgeError
          ? error.message
          : 'Telegram update polling failed.'
        await abortableDelay(1_000, signal)
      }
      if (!this.#connection && !this.#pairing) break
    }
  }

  async processUpdate(update) {
    if (!update || typeof update !== 'object') return false
    if (update.callback_query) return this.#processCallback(update.callback_query)
    if (update.message) return this.#processMessage(update.message)
    return false
  }

  #isBoundPrivateMessage(message) {
    return Boolean(
      this.#connection
      && message?.chat?.type === 'private'
      && asTelegramId(message.chat.id) === this.#connection.chatId
      && asTelegramId(message.from?.id) === this.#connection.account.id
      && message.from?.is_bot !== true,
    )
  }

  async #processMessage(message) {
    const text = typeof message?.text === 'string' ? message.text.trim() : ''
    if (!text) return false

    const pairMatch = text.match(/^\/pair(?:@[a-zA-Z0-9_]+)?\s+([a-zA-Z0-9_-]+)$/i)
    if (pairMatch && this.#pairing) {
      if (
        this.#pairing.expiresAt <= this.#now()
        || message?.chat?.type !== 'private'
        || message.from?.is_bot === true
        || !constantTimeEqual(pairMatch[1].toUpperCase(), this.#pairing.code)
      ) {
        return false
      }
      const account = telegramAccount(message.from)
      const chatId = asTelegramId(message.chat.id)
      if (!account.id || !chatId) return false
      const confirmedAt = this.#now()
      this.#connection = {
        id: base64url(this.#randomBytes(18)),
        confirmedAt,
        account,
        chatId,
      }
      this.#pairing = null
      await this.#api('sendMessage', {
        chat_id: chatId,
        text: 'Ensync paired. New task messages require a separate approval before they run.',
      })
      return true
    }

    if (!this.#isBoundPrivateMessage(message)) return false
    if (text.startsWith('/')) {
      await this.#api('sendMessage', {
        chat_id: this.#connection.chatId,
        text: 'Send a task as a normal message. Ensync will show its project, conversation, provider, action, and an approval control.',
      })
      return true
    }
    if (text.length > MAX_TASK_TEXT_LENGTH) {
      await this.#api('sendMessage', {
        chat_id: this.#connection.chatId,
        text: `Task is too long. Send at most ${MAX_TASK_TEXT_LENGTH.toLocaleString()} characters.`,
      })
      return true
    }

    let context
    try {
      context = await this.#currentTaskContext()
    } catch (error) {
      await this.#api('sendMessage', {
        chat_id: this.#connection.chatId,
        text: error instanceof Error ? error.message : 'No selected Ensync task context is available.',
      })
      return true
    }

    const createdAt = this.#now()
    const approval = {
      id: base64url(this.#randomBytes(12)),
      prompt: text,
      context,
      createdAt,
      expiresAt: createdAt + this.#approvalTtlMs,
      status: 'pending',
      messageId: null,
    }
    const approveData = this.#callbackData(approval.id, 'approve')
    const rejectData = this.#callbackData(approval.id, 'reject')
    const result = await this.#api('sendMessage', {
      chat_id: this.#connection.chatId,
      text: formatApproval(approval),
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: approveData },
          { text: 'Reject', callback_data: rejectData },
        ]],
      },
    })
    approval.messageId = Number.isSafeInteger(result?.message_id) ? result.message_id : null
    this.#approvals.set(approval.id, approval)
    return true
  }

  #callbackData(approvalId, decision) {
    const unsigned = `ens:${approvalId}:${decision}`
    const signature = createHmac('sha256', this.#callbackSecret)
      .update(unsigned)
      .digest('base64url')
      .slice(0, 12)
    return `${unsigned}:${signature}`
  }

  #parseCallbackData(data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64) return null
    const match = data.match(/^ens:([a-zA-Z0-9_-]{8,32}):(approve|reject):([a-zA-Z0-9_-]{12})$/)
    if (!match) return null
    const [, approvalId, decision, signature] = match
    const expected = this.#callbackData(approvalId, decision).split(':').at(-1)
    return expected && constantTimeEqual(signature, expected) ? { approvalId, decision } : null
  }

  async #answerCallback(callbackQueryId, text, showAlert = false) {
    if (typeof callbackQueryId !== 'string' || !callbackQueryId) return
    await this.#api('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    })
  }

  async #clearApprovalKeyboard(approval) {
    if (!Number.isSafeInteger(approval.messageId) || !this.#connection) return
    await this.#api('editMessageReplyMarkup', {
      chat_id: this.#connection.chatId,
      message_id: approval.messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => undefined)
  }

  async #processCallback(query) {
    const parsed = this.#parseCallbackData(query?.data)
    const queryUserId = asTelegramId(query?.from?.id)
    const queryChatId = asTelegramId(query?.message?.chat?.id)
    if (
      !this.#connection
      || !parsed
      || queryUserId !== this.#connection.account.id
      || queryChatId !== this.#connection.chatId
      || query?.message?.chat?.type !== 'private'
    ) {
      await this.#answerCallback(query?.id, 'Not authorized.', true)
      return false
    }

    const approval = this.#approvals.get(parsed.approvalId)
    if (
      !approval
      || approval.messageId !== query?.message?.message_id
      || approval.status !== 'pending'
    ) {
      await this.#answerCallback(query.id, 'This approval is no longer available.', true)
      return false
    }
    if (approval.expiresAt <= this.#now()) {
      approval.status = 'expired'
      await this.#clearApprovalKeyboard(approval)
      await this.#answerCallback(query.id, 'This approval expired.', true)
      return false
    }

    if (parsed.decision === 'reject') {
      approval.status = 'rejected'
      approval.decidedAt = this.#now()
      await this.#clearApprovalKeyboard(approval)
      await this.#answerCallback(query.id, 'Task rejected.')
      await this.#api('sendMessage', {
        chat_id: this.#connection.chatId,
        text: `Rejected: ${approval.prompt}`,
      })
      return true
    }

    approval.status = 'running'
    approval.decidedAt = this.#now()
    await this.#clearApprovalKeyboard(approval)
    await this.#answerCallback(query.id, 'Approved. Ensync is starting the task.')

    if (!this.#chatRunner || typeof this.#chatRunner.run !== 'function') {
      approval.status = 'blocked'
      await this.#api('sendMessage', {
        chat_id: this.#connection.chatId,
        text: 'Approved, but this Ensync Host has no Telegram chat-runner callback connected. Nothing was executed.',
      })
      return false
    }

    try {
      const result = await this.#chatRunner.run({
        source: 'telegram',
        connectionId: this.#connection.id,
        approvalId: approval.id,
        approvedAt: new Date(approval.decidedAt).toISOString(),
        approvedByTelegramUserId: this.#connection.account.id,
        projectId: approval.context.projectId,
        projectPath: approval.context.projectPath,
        conversationId: approval.context.conversationId,
        provider: approval.context.provider,
        prompt: approval.prompt,
        approvalScope: 'task_start_only',
        toolApprovalMode: 'host_required',
        safeFallback: 'host_router_pre_mutation_only',
        ...(approval.context.executionTarget
          ? { executionTarget: approval.context.executionTarget }
          : {}),
      })
      if (!result || typeof result.response !== 'string' || !result.response.trim()) {
        throw new Error('The Ensync chat runner returned no response.')
      }
      approval.status = 'completed'
      approval.completedAt = this.#now()
      approval.completedProvider = typeof result.provider === 'string'
        ? result.provider
        : approval.context.provider
      await this.sendMessage(result.response.trim())
      return true
    } catch (error) {
      approval.status = 'failed'
      approval.completedAt = this.#now()
      await this.#api('sendMessage', {
        chat_id: this.#connection.chatId,
        text: `Ensync task failed: ${error instanceof Error ? error.message : 'Unknown host runner error.'}`,
      })
      return false
    }
  }

  #expireApprovals() {
    const now = this.#now()
    for (const [id, approval] of this.#approvals) {
      if (approval.status === 'pending' && approval.expiresAt <= now) approval.status = 'expired'
      if (approval.createdAt + 60 * 60_000 <= now) this.#approvals.delete(id)
    }
  }
}

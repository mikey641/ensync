import { ChatRunError } from './chat.mjs'

const SUPPORTED_PROVIDERS = new Set(['codex', 'claude'])
const MAX_CONVERSATIONS = 64
const MAX_MESSAGES_PER_CONVERSATION = 40
const MAX_TRANSCRIPT_CHARACTERS = 100_000

function conversationKey(request) {
  const runtime = request.executionTarget?.kind === 'ssh'
    ? `ssh:${request.executionTarget.connection.username}@${request.executionTarget.connection.hostname}:${request.executionTarget.connection.port}:${request.executionTarget.connection.projectPath}`
    : 'local'
  return `${request.projectId}\0${request.conversationId}\0${runtime}`
}

function transcriptFor(messages) {
  const transcript = messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Agent'}: ${message.content}`)
    .join('\n\n')
  return transcript.length <= MAX_TRANSCRIPT_CHARACTERS
    ? transcript
    : transcript.slice(-MAX_TRANSCRIPT_CHARACTERS)
}

function providerReady(provider) {
  return SUPPORTED_PROVIDERS.has(provider?.id)
    && provider.connectionState === 'ready'
    && provider.chatExecution === 'supported'
}

function remoteProviderReady(provider) {
  const method = provider?.authentication?.method?.toLowerCase() ?? ''
  return Boolean(
    provider
    && ['codex', 'claude'].includes(provider.id)
    && provider.directlyRunnable
    && provider.authentication?.state === 'authenticated'
    && (provider.id === 'codex'
      ? method.includes('chatgpt')
      : ['claude.ai', 'oauth', 'subscription'].some((signal) => method.includes(signal))),
  )
}

/**
 * Keeps Telegram turns on the normal subscription CLI boundary. The router
 * remembers only bounded in-memory conversation/session state and retries a
 * different CLI solely when ChatRunService proves the first run was safe to
 * retry before any tool activity.
 */
export class TelegramChatRouter {
  #chatService
  #statusService
  #remoteSshService
  #conversations = new Map()

  constructor(options = {}) {
    if (!options.chatService || !options.statusService) {
      throw new TypeError('TelegramChatRouter requires chat and provider status services.')
    }
    this.#chatService = options.chatService
    this.#statusService = options.statusService
    this.#remoteSshService = options.remoteSshService ?? null
  }

  #conversation(request) {
    const key = conversationKey(request)
    let conversation = this.#conversations.get(key)
    if (!conversation) {
      conversation = { messages: [], sessions: new Map() }
      this.#conversations.set(key, conversation)
      while (this.#conversations.size > MAX_CONVERSATIONS) {
        this.#conversations.delete(this.#conversations.keys().next().value)
      }
    } else {
      // Refresh insertion order so active conversations survive bounded eviction.
      this.#conversations.delete(key)
      this.#conversations.set(key, conversation)
    }
    return conversation
  }

  async #runProvider(request, provider, conversation) {
    const sessionId = conversation.sessions.get(provider) ?? null
    const transcript = sessionId ? '' : transcriptFor(conversation.messages)
    const prompt = transcript
      ? `${transcript}\n\nUser: ${request.prompt}`
      : request.prompt
    if (request.executionTarget?.kind === 'ssh') {
      if (!this.#remoteSshService) {
        throw new ChatRunError(
          'remote_runtime_unavailable',
          'This Ensync Host has no SSH runtime connected to Telegram.',
          409,
          true,
        )
      }
      return this.#remoteSshService.runChat({
        connection: request.executionTarget.connection,
        provider,
        prompt,
        sessionId,
      })
    }
    return this.#chatService.run({ provider, projectPath: request.projectPath, prompt, sessionId })
  }

  async run(request) {
    if (
      request?.source !== 'telegram'
      || typeof request.approvalId !== 'string'
      || request.approvalScope !== 'task_start_only'
      || request.toolApprovalMode !== 'host_required'
    ) {
      throw new ChatRunError(
        'telegram_approval_required',
        'A verified task-start approval with host tool controls is required before this Telegram task can run.',
        403,
      )
    }
    if (!SUPPORTED_PROVIDERS.has(request.provider)) {
      throw new ChatRunError(
        'unsupported_provider',
        'Telegram execution currently supports Codex and Claude Code.',
        422,
      )
    }
    if (typeof request.projectPath !== 'string' || !request.projectPath) {
      throw new ChatRunError(
        'invalid_project',
        'The selected Telegram conversation has no verified project path.',
      )
    }

    const conversation = this.#conversation(request)
    let selectedProvider = request.provider
    let result
    try {
      result = await this.#runProvider(request, selectedProvider, conversation)
    } catch (error) {
      if (!error || error.safeToRetry !== true) throw error
      let fallback
      if (request.executionTarget?.kind === 'ssh') {
        const probe = await this.#remoteSshService?.probe(request.executionTarget.connection)
        fallback = probe?.providers.find((provider) =>
          provider.id !== selectedProvider && remoteProviderReady(provider))
      } else {
        const providers = await this.#statusService.list({ refresh: true })
        fallback = providers.find((provider) =>
          provider.id !== selectedProvider && providerReady(provider))
      }
      if (!fallback) throw error
      selectedProvider = fallback.id
      result = await this.#runProvider(request, selectedProvider, conversation)
    }

    if (result.sessionId) conversation.sessions.set(selectedProvider, result.sessionId)
    conversation.messages.push(
      { role: 'user', content: request.prompt },
      { role: 'agent', content: result.response },
    )
    if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES_PER_CONVERSATION)
    }
    return result
  }
}

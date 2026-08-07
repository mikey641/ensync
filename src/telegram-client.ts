export type TelegramBotIdentity = {
  id: string
  username: string
  displayName: string
}

export type TelegramAccountIdentity = {
  id: string
  username: string | null
  displayName: string
}

export type TelegramPendingApproval = {
  id: string
  projectId: string
  projectLabel: string
  conversationId: string
  provider: string
  action: string
  expiresAt: string
}

type TelegramStatusBase = {
  bot: TelegramBotIdentity | null
  tokenStorage: 'none' | 'memory_only'
  encryptedCredentialStorage: false
  lastError: string | null
  pendingApprovals: TelegramPendingApproval[]
}

export type TelegramBridgeStatus = TelegramStatusBase & (
  | { state: 'disconnected' | 'verified' }
  | {
      state: 'pairing'
      pairingId: string
      code: string
      expiresAt: string
    }
  | {
      state: 'connected'
      connectionId: string
      confirmedAt: string
      telegramAccount: TelegramAccountIdentity
      chatId: string
    }
)

export type TelegramPairingStart = {
  pairingId: string
  code: string
  expiresAt: string
  bot: TelegramBotIdentity
  tokenStorage: 'memory_only'
  encryptedCredentialStorage: false
}

export type TelegramTaskContext = {
  projectId: string
  projectLabel: string
  projectPath?: string | null
  conversationId: string
  provider: string
  executionTarget?:
    | { kind: 'local' }
    | { kind: 'ssh'; connection: import('./lib/remoteSsh').RemoteSshConnectionInput }
}

export type TelegramDelivery = {
  connectionId: string
  deliveries: Array<{ messageId: number | null; sentAt: string }>
}

export type TelegramHostClient = {
  startPairing(botToken: string): Promise<TelegramPairingStart>
  getStatus(): Promise<TelegramBridgeStatus>
  disconnect(): Promise<TelegramBridgeStatus>
  sendMessage(text: string): Promise<TelegramDelivery>
  setTaskContext(context: TelegramTaskContext): Promise<TelegramTaskContext>
}

async function jsonRequest<T>(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetcher(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers: init?.body
        ? { 'Content-Type': 'application/json', ...init.headers }
        : init?.headers,
    })
  } catch {
    throw new Error('The local Ensync Host could not be reached.')
  }
  const body = await response.json().catch(() => null) as { error?: unknown } | null
  if (!response.ok || body === null) {
    throw new Error(
      typeof body?.error === 'string'
        ? body.error
        : `Ensync Host returned ${response.status}.`,
    )
  }
  return body as T
}

/** Browser adapter for the loopback-only Ensync Host Telegram routes. */
export function createTelegramHostClient(
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): TelegramHostClient {
  const baseUrl = (options.baseUrl ?? '/api/telegram').replace(/\/$/, '')
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  return {
    startPairing: (botToken) => jsonRequest(fetcher, `${baseUrl}/pair`, {
      method: 'POST',
      body: JSON.stringify({ botToken }),
    }),
    getStatus: () => jsonRequest(fetcher, `${baseUrl}/status`),
    disconnect: () => jsonRequest(fetcher, `${baseUrl}/disconnect`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    sendMessage: (text) => jsonRequest(fetcher, `${baseUrl}/send`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
    setTaskContext: (context) => jsonRequest(fetcher, `${baseUrl}/context`, {
      method: 'POST',
      body: JSON.stringify(context),
    }),
  }
}

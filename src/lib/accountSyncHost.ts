export type AccountSyncStatus = {
  configured: boolean
  authenticated: boolean
  username: string | null
  remoteRevision: number | null
  lastSyncedAt: string | null
  encryption: 'aes-256-gcm'
  credentialStorage: 'host_memory_only'
  liveTransport: 'server_sent_events'
  executionAuthority: 'account_server' | 'device_host'
}

export type AccountSyncLiveEvent = {
  type: 'connected' | 'workspace_updated'
  revision: number
  updatedAt: string | null
}

export type AccountWorkspacePull = {
  state: unknown | null
  revision: number
  updatedAt: string | null
}

export type AccountWorkspacePush =
  | { status: 'saved'; revision: number; updatedAt: string }
  | { status: 'conflict'; revision: number; updatedAt: string | null; remoteState: unknown }

type ErrorPayload = { error?: string; code?: string }
const MAX_LIVE_EVENT_CHARACTERS = 64 * 1024

function parseLiveEvent(block: string): AccountSyncLiveEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  const value: unknown = JSON.parse(data)
  if (!value || typeof value !== 'object') throw new Error('The live account stream returned an invalid event.')
  const event = value as Partial<AccountSyncLiveEvent>
  if (!['connected', 'workspace_updated'].includes(event.type ?? '')
    || !Number.isSafeInteger(event.revision)
    || (event.revision ?? -1) < 0
    || (event.updatedAt !== null && typeof event.updatedAt !== 'string')) {
    throw new Error('The live account stream returned an invalid event.')
  }
  return event as AccountSyncLiveEvent
}

export class AccountSyncHostError extends Error {
  status: number
  code: string | null

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = 'AccountSyncHostError'
    this.status = status
    this.code = typeof payload === 'object' && payload !== null && typeof (payload as ErrorPayload).code === 'string'
      ? (payload as ErrorPayload).code ?? null
      : null
  }
}

export class AccountSyncHostClient {
  readonly baseUrl: string

  constructor(baseUrl = '/api/account-sync') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    const payload: unknown = await response.json()
    if (!response.ok) {
      const error = typeof payload === 'object' && payload !== null ? payload as ErrorPayload : null
      throw new AccountSyncHostError(
        error?.error ?? `Account sync request failed (${response.status}).`,
        response.status,
        payload,
      )
    }
    return payload as T
  }

  status() {
    return this.request<AccountSyncStatus>('/status')
  }

  register(username: string, password: string) {
    return this.request<AccountSyncStatus>('/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  login(username: string, password: string) {
    return this.request<AccountSyncStatus>('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  logout() {
    return this.request<AccountSyncStatus>('/logout', { method: 'POST' })
  }

  pull() {
    return this.request<AccountWorkspacePull>('/workspace')
  }

  push(state: unknown, baseRevision: number) {
    return this.request<AccountWorkspacePush>('/workspace', {
      method: 'PUT',
      body: JSON.stringify({ state, baseRevision }),
    })
  }

  async subscribe(
    onEvent: (event: AccountSyncLiveEvent) => void,
    options: { signal?: AbortSignal; afterRevision?: number } = {},
  ) {
    const afterRevision = Number.isSafeInteger(options.afterRevision) && (options.afterRevision ?? -1) >= 0
      ? options.afterRevision
      : 0
    const response = await fetch(`${this.baseUrl}/events?after=${afterRevision}`, {
      headers: { Accept: 'text/event-stream' },
      signal: options.signal,
    })
    if (!response.ok) {
      let payload: unknown = null
      try { payload = await response.json() } catch { /* use the status fallback below */ }
      const error = typeof payload === 'object' && payload !== null ? payload as ErrorPayload : null
      throw new AccountSyncHostError(
        error?.error ?? `Live account connection failed (${response.status}).`,
        response.status,
        payload,
      )
    }
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      throw new Error('Ensync Host did not return a live account stream.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffered)
        if (!match || match.index === undefined) break
        const block = buffered.slice(0, match.index)
        buffered = buffered.slice(match.index + match[0].length)
        const event = parseLiveEvent(block)
        if (event) onEvent(event)
      }
      if (buffered.length > MAX_LIVE_EVENT_CHARACTERS) {
        await reader.cancel()
        throw new Error('A live account event exceeded the safe size limit.')
      }
    }
  }
}

export const accountSyncHost = new AccountSyncHostClient()

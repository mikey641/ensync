export type AccountSyncStatus = {
  configured: boolean
  authenticated: boolean
  username: string | null
  remoteRevision: number | null
  lastSyncedAt: string | null
  encryption: 'aes-256-gcm'
  credentialStorage: 'host_memory_only'
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
}

export const accountSyncHost = new AccountSyncHostClient()


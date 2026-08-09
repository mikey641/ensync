export type AccountSyncStatus = {
  configured: boolean
  authenticated: boolean
  username: string | null
  remoteRevision: number | null
  lastSyncedAt: string | null
  encryption: 'aes-256-gcm'
  credentialStorage: 'host_memory_only'
  brokerDevice: {
    id: string
    role: 'host' | 'client'
    label: string
    registeredAt: string
    lastSeenAt: string | null
  } | null
}

export type SyncBrokerHostStatus = {
  state: 'disconnected' | 'connected' | 'degraded'
  running: boolean
  host: AccountSyncStatus['brokerDevice']
  lastPollAt: string | null
  lastError: { code: string; message: string; status: number; safeToRetry: boolean } | null
  activeJobs: number
  transport: 'outbound_https_poll'
  encryption: 'aes-256-gcm'
}

export type SyncBrokerPairing = {
  pairing: {
    id: string
    host: NonNullable<AccountSyncStatus['brokerDevice']>
    client: AccountSyncStatus['brokerDevice']
    createdAt: string
    expiresAt: string
    claimedAt: string | null
    revokedAt: string | null
  }
  code: string
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

  brokerStatus() {
    return this.request<SyncBrokerHostStatus>('/broker/status')
  }

  connectBrokerHost(deviceId: string, label: string) {
    return this.request<SyncBrokerHostStatus>('/broker/connect', {
      method: 'POST',
      body: JSON.stringify({ deviceId, label }),
    })
  }

  createBrokerPairing() {
    return this.request<SyncBrokerPairing>('/broker/pairing', {
      method: 'POST',
      body: '{}',
    })
  }

  pollBrokerHost() {
    return this.request<SyncBrokerHostStatus>('/broker/poll', {
      method: 'POST',
      body: '{}',
    })
  }

  disconnectBrokerHost(revoke = false) {
    return this.request<SyncBrokerHostStatus>('/broker/disconnect', {
      method: 'POST',
      body: JSON.stringify({ revoke }),
    })
  }
}

export const accountSyncHost = new AccountSyncHostClient()

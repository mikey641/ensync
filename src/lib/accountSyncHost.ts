export type AccountSyncStatus = {
  configured: boolean
  serviceUrl: string | null
  authenticated: boolean
  username: string | null
  remoteRevision: number | null
  lastSyncedAt: string | null
  encryption: 'aes-256-gcm'
  credentialStorage: 'host_memory_only' | 'macos_keychain' | 'windows_dpapi' | string
  phoneSync?: {
    enabled: boolean
    credentialStorage: string
    restoreError: { code: string; message: string } | null
  }
}

export type PhoneLink = {
  url: string
  expiresAt: string
  persistent: boolean
  host: { id: string; label: string }
}

export type LinkedPhone = {
  pairingId: string
  deviceId: string
  label: string
  pairedAt: string | null
  lastSeenAt: string | null
}

export type WorkspaceWait = { changed: boolean; revision: number }

export type AccountWorkspacePull = {
  state: unknown | null
  revision: number
  updatedAt: string | null
}

export type AccountWorkspacePush =
  | { status: 'saved'; revision: number; updatedAt: string }
  | { status: 'conflict'; revision: number; updatedAt: string | null; remoteState: unknown }

export type SecondFactorChallenge = {
  stage: 'second_factor'
  challengeId: string
  methods: string[]
  recoveryAvailable: boolean
}

export type AccountProfile = {
  username: string
  email: string | null
  twoFactorEnabled: boolean
  recoveryRemaining: number
  createdAt: string
}

export type TotpStart = {
  secret: string
  uri: string
  challengeId: string
}

export type TotpConfirm = {
  twoFactorEnabled: boolean
  recoveryCodes: string[]
}

export type LoginResult = AccountSyncStatus | SecondFactorChallenge

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

  register(username: string, password: string, email?: string) {
    return this.request<AccountSyncStatus>('/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, ...(email ? { email } : {}) }),
    })
  }

  login(username: string, password: string) {
    return this.request<LoginResult>('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  verifySecondFactor(challengeId: string, credentials: { code?: string; recoveryCode?: string }) {
    return this.request<AccountSyncStatus>('/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId, ...credentials }),
    })
  }

  account() {
    return this.request<AccountProfile>('/account')
  }

  startTotp() {
    return this.request<TotpStart>('/totp/start', { method: 'POST' })
  }

  confirmTotp(challengeId: string, code: string) {
    return this.request<TotpConfirm>('/totp/confirm', {
      method: 'POST',
      body: JSON.stringify({ challengeId, code }),
    })
  }

  disableTotp(credentials: { code?: string; recoveryCode?: string }) {
    return this.request<{ twoFactorEnabled: boolean }>('/totp/disable', {
      method: 'POST',
      body: JSON.stringify(credentials),
    })
  }

  setEmail(email: string) {
    return this.request<{ email: string | null }>('/email', {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
  }

  logout() {
    return this.request<AccountSyncStatus>('/logout', { method: 'POST' })
  }

  pull() {
    return this.request<AccountWorkspacePull>('/workspace')
  }

  /** One-shot phone setup; the returned URL carries the link only in its fragment. */
  phoneLink(input: { syncUrl?: string | null; label?: string | null } = {}) {
    return this.request<PhoneLink>('/phone-link', {
      method: 'POST',
      body: JSON.stringify({
        ...(input.syncUrl ? { syncUrl: input.syncUrl } : {}),
        ...(input.label ? { label: input.label } : {}),
      }),
    })
  }

  phones() {
    return this.request<{ phones: LinkedPhone[] }>('/phones')
  }

  revokePhone(pairingId: string) {
    return this.request<{ phones: LinkedPhone[] }>('/phones/revoke', {
      method: 'POST',
      body: JSON.stringify({ pairingId }),
    })
  }

  /** Long-polls the Host for a newer workspace revision (the Host holds the key). */
  waitWorkspace(after: number, timeoutSeconds = 25, signal?: AbortSignal) {
    const revision = Number.isSafeInteger(after) && after >= 0 ? after : 0
    return this.request<WorkspaceWait>(`/workspace/wait?after=${revision}&timeout=${timeoutSeconds}`, { signal })
  }

  push(state: unknown, baseRevision: number) {
    return this.request<AccountWorkspacePush>('/workspace', {
      method: 'PUT',
      body: JSON.stringify({ state, baseRevision }),
    })
  }
}

export const accountSyncHost = new AccountSyncHostClient()

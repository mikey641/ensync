export type RemoteBrokerState = 'connected' | 'degraded' | 'disconnected'
export type RemoteBrokerRole = 'host' | 'client'
export type RemoteBrokerJobState =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'reconciliation_required'

export type RemoteBrokerErrorPayload = {
  code: string
  message: string
  status: number
  safeToRetry: boolean
}

export type RemoteBrokerDevice = {
  id: string
  role: RemoteBrokerRole
  label: string
  registeredAt: string | null
  lastSeenAt: string | null
}

export type RemoteBrokerProviderCapability = {
  id: string
  name: string
  available: boolean
}

export type RemoteBrokerProjectCapability = {
  path: string
  name?: string
}

export type RemoteBrokerCapabilities = {
  providers: RemoteBrokerProviderCapability[]
  recentProjects: RemoteBrokerProjectCapability[]
}

export type RemoteBrokerHostStatus = {
  state: RemoteBrokerState
  running: boolean
  host: RemoteBrokerDevice | null
  lastPollAt: string | null
  lastError: RemoteBrokerErrorPayload | null
  activeJobs: number
  transport: string
  encryption: string
  brokerDevice: { id: string; role: RemoteBrokerRole } | null
}

export type RemoteBrokerPairing = {
  id: string
  host: (RemoteBrokerDevice & { capabilities: RemoteBrokerCapabilities | null }) | null
  client: RemoteBrokerDevice | null
  createdAt: string | null
  expiresAt: string | null
  claimedAt: string | null
  revokedAt: string | null
}

export type RemoteBrokerPairingOffer = {
  pairing: RemoteBrokerPairing
  code: string
}

export type RemoteBrokerHostListing = RemoteBrokerDevice & {
  capabilities: RemoteBrokerCapabilities | null
  pairedAt: string | null
}

export type RemoteBrokerJobEvent = {
  type: string
  provider?: string | null
  message?: string | null
  error?: string | null
  code?: string | null
  status?: number | null
  safeToRetry?: boolean
  result?: { response?: string | null; [key: string]: unknown } | null
  at?: string | null
  [key: string]: unknown
}

export type RemoteBrokerJobEventRecord = {
  sequence: number
  createdAt: string | null
  event: RemoteBrokerJobEvent
}

export type RemoteBrokerCommandAcknowledgement = {
  accepted: boolean
  [key: string]: unknown
}

export type RemoteBrokerJobCommand = {
  id: string
  sequence: number
  type: 'cancel' | 'steer'
  state: string | null
  createdAt: string | null
  claimedAt: string | null
  ackedAt: string | null
  acknowledgement: {
    version?: number
    acknowledgement?: RemoteBrokerCommandAcknowledgement
    [key: string]: unknown
  } | null
}

export type RemoteBrokerJob = {
  id: string
  hostId: string
  clientId: string
  state: RemoteBrokerJobState
  createdAt: string | null
  claimedAt: string | null
  terminalAt: string | null
  lastEventSequence: number
  events: RemoteBrokerJobEventRecord[]
  commands: RemoteBrokerJobCommand[]
}

export type RemoteBrokerCommandResult = {
  id: string
  sequence: number
  type: 'cancel' | 'steer'
  state: string | null
  createdAt: string | null
  claimedAt: string | null
  ackedAt: string | null
}

type ErrorPayload = { error?: string; code?: string }

export class RemoteBrokerHostError extends Error {
  status: number
  code: string | null

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = 'RemoteBrokerHostError'
    this.status = status
    this.code = typeof payload === 'object' && payload !== null && typeof (payload as ErrorPayload).code === 'string'
      ? (payload as ErrorPayload).code ?? null
      : null
  }
}

type RemoteBrokerRawCommand = {
  id: string
  sequence: number
  type: 'cancel' | 'steer'
  state?: string | null
  createdAt?: string | null
  claimedAt?: string | null
  ackedAt?: string | null
  envelope?: unknown
  ackEnvelope?: unknown
  requestHash?: string
}

export class RemoteBrokerHostClient {
  readonly baseUrl: string

  constructor(baseUrl = '/api/remote/broker') {
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
      throw new RemoteBrokerHostError(
        error?.error ?? `Remote execution request failed (${response.status}).`,
        response.status,
        payload,
      )
    }
    return payload as T
  }

  /** Current worker state, including whether this device is registered as a Host or client. */
  status() {
    return this.request<RemoteBrokerHostStatus>('/status')
  }

  start(label?: string) {
    return this.request<RemoteBrokerHostStatus>('/start', {
      method: 'POST',
      body: JSON.stringify(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
    })
  }

  pairing() {
    return this.request<RemoteBrokerPairingOffer>('/pairing', { method: 'POST' })
  }

  stop(revoke = false) {
    return this.request<RemoteBrokerHostStatus>('/stop', {
      method: 'POST',
      body: JSON.stringify({ revoke: revoke === true }),
    })
  }

  capabilities() {
    return this.request<{ capabilities: RemoteBrokerCapabilities }>('/capabilities', { method: 'POST' })
  }

  registerClient(label?: string) {
    return this.request<{ device: RemoteBrokerDevice }>('/client/register', {
      method: 'POST',
      body: JSON.stringify(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
    })
  }

  claimClient(code: string) {
    return this.request<{ pairing: RemoteBrokerPairing }>('/client/claim', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
  }

  listClientHosts() {
    return this.request<{ hosts: RemoteBrokerHostListing[] }>('/client/hosts')
  }

  submitClientJob(input: { hostId: string; provider: string; projectPath: string; prompt: string }) {
    return this.request<{ job: RemoteBrokerJob }>('/client/job', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  getClientJob(jobId: string, after = 0) {
    const sequence = Number.isSafeInteger(after) && after >= 0 ? after : 0
    return this.request<{ job: RemoteBrokerJob }>(
      `/client/job?jobId=${encodeURIComponent(jobId)}&after=${sequence}`,
    )
  }

  /**
   * Sends a cancellation or steer command. The raw command envelope is never
   * returned to the renderer, so callers only ever see the public command record.
   */
  async sendClientCommand(jobId: string, type: 'cancel' | 'steer', payload: { prompt?: string; idempotencyKey?: string } = {}) {
    const response = await this.request<{ command: RemoteBrokerRawCommand }>('/client/command', {
      method: 'POST',
      body: JSON.stringify({ jobId, type, payload }),
    })
    const { id, sequence, createdAt, claimedAt, ackedAt } = response.command
    const command: RemoteBrokerCommandResult = {
      id,
      sequence,
      type,
      state: response.command.state ?? null,
      createdAt: createdAt ?? null,
      claimedAt: claimedAt ?? null,
      ackedAt: ackedAt ?? null,
    }
    return { command }
  }
}

export const remoteBrokerHost = new RemoteBrokerHostClient()

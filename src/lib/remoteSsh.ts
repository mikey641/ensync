import type {
  ChatModelEffort,
  ChatOutputRecovery,
  ChatProviderId,
  ChatRunUsage,
  ChatRunWorkspace,
  CliProviderId,
} from './ensyncHost'

export type RemoteSshConnectionInput = {
  hostname: string
  username: string
  port: number
  /** Absolute path on this computer. Ensync Host uses it for this request and does not store key contents. */
  identityFile?: string | null
  /** Absolute project directory on the remote machine. */
  projectPath: string
}

export type RemoteSshProviderProbe = {
  id: CliProviderId
  installed: boolean
  command: string
  executable: string | null
  directlyRunnable: boolean
  version: string | null
  reason?: string
  authentication: {
    state: 'authenticated' | 'not_authenticated' | 'unavailable'
    method: string | null
    reason: string
    exactPlan?: string | null
  } | null
}

export type RemoteSshProbe = {
  transport: {
    state: 'verified'
    hostKeyVerification: 'strict_known_hosts'
    target: {
      hostname: string
      username: string
      port: number
      projectPath: string
      identityMode: 'identity_file' | 'ssh_agent_or_default_identity'
    }
  }
  remote: {
    platform: string
    release: string
    arch: string
    hostname: string
  } | null
  node: {
    available: boolean
    version: string | null
    executable?: string
    reason?: string
  }
  project: {
    requestedPath: string
    canonicalPath: string | null
  }
  git: {
    installed?: boolean
    executable?: string | null
    version?: string | null
    availability?: 'unknown'
    reason?: string
  }
  providers: RemoteSshProviderProbe[]
  checkedAt: string
}

export type RemoteSshChatRequest = {
  connection: RemoteSshConnectionInput
  workspaceKey: string
  provider: ChatProviderId
  prompt: string
  sessionId?: string | null
  model?: string | null
  effort?: ChatModelEffort | null
  timeoutMs?: number
}

export type RemoteSshChatResponse = {
  provider: ChatProviderId
  projectPath: string
  workspace?: ChatRunWorkspace | null
  response: string
  sessionId: string | null
  model: string | null
  requestedModel: string | null
  requestedEffort: ChatModelEffort | null
  usage: ChatRunUsage | null
  outputRecovery?: ChatOutputRecovery | null
  durationMs: number
  completedAt: string
  remote: {
    platform: string
    release: string
    arch: string
    hostname: string
    nodeVersion: string
    target: {
      hostname: string
      username: string
      port: number
    }
    hostKeyVerification: 'strict_known_hosts'
  }
}

type RemoteErrorPayload = {
  error?: string
  code?: string
  safeToRetry?: boolean
}

export class RemoteSshClientError extends Error {
  status: number
  code: string | null
  safeToRetry: boolean

  constructor(message: string, status: number, payload: RemoteErrorPayload) {
    super(message)
    this.name = 'RemoteSshClientError'
    this.status = status
    this.code = typeof payload.code === 'string' ? payload.code : null
    this.safeToRetry = payload.safeToRetry === true
  }
}

/**
 * Thin contract for the loopback Ensync Host routes. The client keeps no SSH
 * passwords, key material, or connection profile in browser storage.
 */
export class RemoteSshHostClient {
  readonly baseUrl: string

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      })
      const payload = await response.json() as T & RemoteErrorPayload
      if (!response.ok) {
        throw new RemoteSshClientError(
          typeof payload.error === 'string' ? payload.error : `Remote SSH request failed (${response.status}).`,
          response.status,
          payload,
        )
      }
      return payload
    } catch (error) {
      if (signal?.aborted) {
        throw new RemoteSshClientError(
          'Run stopped by user. The SSH process and its remote command were terminated.',
          499,
          { code: 'run_cancelled', safeToRetry: false },
        )
      }
      throw error
    }
  }

  async probe(connection: RemoteSshConnectionInput) {
    const payload = await this.post<{ probe: RemoteSshProbe }>('/remote/ssh/probe', connection)
    return payload.probe
  }

  async runChat(request: RemoteSshChatRequest, signal?: AbortSignal) {
    return this.post<RemoteSshChatResponse>('/remote/ssh/chat', request, signal)
  }
}

export const remoteSshHost = new RemoteSshHostClient()

import type { CliProviderId } from './ensyncHost'

export type McpTransport = 'stdio' | 'http' | 'sse'

/** A registry entry as the Host exposes it: env and header values are masked. */
export type McpServer = {
  id: string
  name: string
  transport: McpTransport
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  createdAt: string | null
  updatedAt: string | null
}

export type McpServerInput = {
  name: string
  transport: McpTransport
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
  enabled?: boolean
}

export type McpSyncCapability = 'supported' | 'discovery_only' | 'unavailable'

export type McpProviderSyncState =
  | 'never'
  | 'synced'
  | 'skipped'
  | 'deferred'
  | 'error'
  | 'unsupported'
  | 'unavailable'

export type McpProviderSync = {
  id: CliProviderId
  name: string
  capability: McpSyncCapability
  installed: boolean | null
  configPath: string | null
  state: McpProviderSyncState
  reason: string
  managedNames: string[]
  conflicts: string[]
  skipped: Array<{ name: string; reason: string }>
  syncedAt: string | null
  documentationUrl: string | null
}

export type McpRegistrySnapshot = {
  registryPath: string
  readable: boolean
  unreadableReason: string | null
  servers: McpServer[]
  providers: McpProviderSync[]
  lastSyncAt: string | null
  syncPending: boolean
  updatedAt: string | null
  imported?: string[]
}

/** Sending this value back for an env or header entry keeps the stored secret. */
export const MCP_SECRET_MASK = '••••••••'

type ErrorPayload = { error?: string; code?: string }

export class McpServersHostError extends Error {
  status: number
  code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'McpServersHostError'
    this.status = status
    this.code = code
  }
}

export class McpServersHostClient {
  readonly baseUrl: string

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      })
    } catch {
      throw new McpServersHostError('Ensync Host is not reachable.', 0, 'host_unreachable')
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new McpServersHostError('Ensync Host returned a non-JSON response.', response.status, 'invalid_host_response')
    }
    if (!response.ok) {
      const error = typeof payload === 'object' && payload !== null ? (payload as ErrorPayload) : null
      throw new McpServersHostError(
        error?.error ?? `Ensync Host request failed (${response.status}).`,
        response.status,
        error?.code ?? null,
      )
    }
    return payload as T
  }

  list() {
    return this.request<McpRegistrySnapshot>('/mcp/servers')
  }

  add(server: McpServerInput) {
    return this.request<McpRegistrySnapshot>('/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({ server }),
    })
  }

  importJson(json: string) {
    return this.request<McpRegistrySnapshot>('/mcp/servers/import', {
      method: 'POST',
      body: JSON.stringify({ json }),
    })
  }

  update(id: string, server: McpServerInput) {
    return this.request<McpRegistrySnapshot>(`/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ server }),
    })
  }

  setEnabled(id: string, enabled: boolean) {
    return this.request<McpRegistrySnapshot>(`/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  }

  remove(id: string) {
    return this.request<McpRegistrySnapshot>(`/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  sync() {
    return this.request<McpRegistrySnapshot>('/mcp/sync', { method: 'POST' })
  }
}

export const mcpServersHost = new McpServersHostClient()

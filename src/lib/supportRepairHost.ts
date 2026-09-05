import type { ChatProviderId, ChatRunResponse } from './ensyncHost'

export type SupportRepairRequest = {
  provider: ChatProviderId
  /** Must match the ID returned by the latest Ensync Host project inspection. */
  projectId: string
  /** Re-inspected and canonicalized by Ensync Host immediately before the run. */
  projectPath: string
  /** Stable identity for the protected repair worktree created before execution. */
  workspaceKey: string
  prompt: string
  diagnostics: {
    summary: string
    details?: string | null
  }
  consent: {
    fixWithMySubscription: true
    allowProjectEdits: true
  }
  sessionId?: string | null
  model?: string | null
  timeoutMs?: number
}

export type SupportRepairRetry = {
  /** Support repairs are never replayed automatically, even with zero-activity proof. */
  automatic: false
  safeToRetry: boolean
  reason: string
}

export type SupportRepairResponse = {
  /** A structured CLI run completed; this is not an independent claim that the bug is fixed. */
  status: 'agent_run_completed'
  verification: 'requires_user_review'
  project: {
    id: string
    name: string | null
    path: string
    inspectedAt: string | null
  }
  run: ChatRunResponse
  policy: {
    execution: 'authenticated_subscription_cli_only'
    projectScope: 'exact_host_verified_project'
    projectEdits: 'user_authorized'
    gitCommit: 'forbidden'
    gitPush: 'forbidden'
    productionDeploy: 'forbidden'
    externalTicketMutation: 'forbidden'
    automaticRetry: false
  }
  retry: SupportRepairRetry
}

type SupportRepairErrorPayload = {
  error?: string
  code?: string
  safeToRetry?: boolean
  retry?: SupportRepairRetry
}

export class SupportRepairHostError extends Error {
  status: number
  code: string | null
  safeToRetry: boolean
  retry: SupportRepairRetry

  constructor(message: string, status: number, payload: SupportRepairErrorPayload) {
    super(message)
    this.name = 'SupportRepairHostError'
    this.status = status
    this.code = typeof payload.code === 'string' ? payload.code : null
    this.safeToRetry = payload.safeToRetry === true
    this.retry = payload.retry ?? {
      automatic: false,
      safeToRetry: false,
      reason: 'Ensync Host did not return verifiable retry safety. Do not retry automatically.',
    }
  }
}

/** Thin client for the opt-in local Ensync Host repair route. */
export class SupportRepairHostClient {
  readonly baseUrl: string

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async run(request: SupportRepairRequest) {
    const response = await fetch(`${this.baseUrl}/support/repair`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    })
    const payload = await response.json() as SupportRepairResponse & SupportRepairErrorPayload
    if (!response.ok) {
      throw new SupportRepairHostError(
        typeof payload.error === 'string'
          ? payload.error
          : `Support repair request failed (${response.status}).`,
        response.status,
        payload,
      )
    }
    return payload
  }
}

export const supportRepairHost = new SupportRepairHostClient()

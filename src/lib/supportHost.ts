export type SupportCategory =
  | 'bug'
  | 'connection'
  | 'usage'
  | 'git'
  | 'remote'
  | 'telegram'
  | 'other'

export type SupportChannelAvailability = {
  available: boolean
  reason: string
}

export type SupportAvailability = {
  localReports: SupportChannelAvailability & {
    storage: 'browser_local'
  }
  humanHelpDesk: SupportChannelAvailability & {
    responseSla: null
  }
  githubIssues: SupportChannelAvailability & {
    mode: 'prepare_url_only'
    url: string | null
  }
  aiRepair: SupportChannelAvailability
  checkedAt: string
}

export type SupportProviderDiagnostic = {
  id: string
  installed: boolean
  version: string | null
  connectionState: string
  authenticationState: string
  chatExecution: string
}

export type SupportProjectDiagnostic = {
  selected: true
  id: string | null
  name: string | null
  host: string
  relayDirectory: boolean
  relayFileCount: number | null
  featureFileCount: number | null
  instructionAdapters: string[]
  contextTruncated: boolean
  contextInspectionSucceeded: boolean
}

export type UnavailableDiagnostic = {
  available: false
  reason: string
}

export type SupportDiagnostics = {
  collectedAt: string
  app: {
    name: 'Ensync'
    version: string | null
    buildChannel: string | null
  }
  runtime: {
    platform: string
    release: string
    architecture: string
    nodeVersion: string
  }
  providers:
    | { available: true; items: SupportProviderDiagnostic[] }
    | UnavailableDiagnostic
  project:
    | { available: true; value: SupportProjectDiagnostic | null }
    | UnavailableDiagnostic
  privacy: {
    chatTextAutomaticallyCollected: false
    secretsAutomaticallyCollected: false
    fileContentsAutomaticallyCollected: false
    absolutePathsAutomaticallyCollected: false
    environmentVariablesAutomaticallyCollected: false
    commandOutputAutomaticallyCollected: false
    userProvidedTicketTextIncluded: true
    note: string
  }
}

export type SupportReport = {
  schemaVersion: 1
  ticket: {
    id: string
    status: 'local_draft'
    category: SupportCategory
    summary: string
    description: string
    createdAt: string
  }
  diagnostics: SupportDiagnostics
  review: {
    requiredBeforeExport: true
    reviewedAt: string | null
    externalSubmission: false
    note: string
  }
}

export type SupportPreviewRequest = {
  category: SupportCategory
  summary: string
  description: string
  includeProjectContext: boolean
}

export type SupportPreviewResponse = {
  report: SupportReport
  availability: SupportAvailability
}

export type PreparedGitHubIssue = {
  issue: {
    url: string
    submitted: false
    mode: 'prepare_url_only'
    warning: string
  }
  report: SupportReport
}

export type LocalSupportTicketStatus =
  | 'report_ready'
  | 'downloaded'
  | 'github_draft_opened'
  | 'ai_fix_started'
  | 'resolved_locally'

export type LocalSupportTicket = {
  id: string
  summary: string
  category: SupportCategory
  status: LocalSupportTicketStatus
  createdAt: string
  updatedAt: string
}

export type SupportRepairProvider = 'codex' | 'claude'

export type SupportRepairRequest = {
  provider: SupportRepairProvider
  projectId: string
  projectPath: string
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

export type SupportRepairResponse = {
  status: 'agent_run_completed'
  verification: 'requires_user_review'
  project: {
    id: string
    name: string | null
    path: string
    inspectedAt: string | null
  }
  run: {
    provider: SupportRepairProvider
    projectPath: string
    response: string
    sessionId: string | null
    model: string | null
    requestedModel: string | null
    usage: {
      source: 'cli'
      inputTokens: number | null
      outputTokens: number | null
      cachedInputTokens: number | null
    } | null
    durationMs: number
    completedAt: string
  }
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
  retry: {
    automatic: false
    safeToRetry: false
    reason: string
  }
}

type ErrorPayload = {
  error?: string
  code?: string
  safeToRetry?: boolean
  retry?: {
    automatic: false
    safeToRetry: boolean
    reason: string
  }
}

export class SupportHostError extends Error {
  status: number
  code: string | null
  safeToRetry: boolean
  retry: ErrorPayload['retry'] | null
  payload: unknown

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = 'SupportHostError'
    this.status = status
    this.payload = payload
    this.code = typeof payload === 'object'
      && payload !== null
      && typeof (payload as ErrorPayload).code === 'string'
      ? (payload as ErrorPayload).code ?? null
      : null
    this.safeToRetry = typeof payload === 'object'
      && payload !== null
      && (payload as ErrorPayload).safeToRetry === true
    this.retry = typeof payload === 'object'
      && payload !== null
      && (payload as ErrorPayload).retry
      ? (payload as ErrorPayload).retry ?? null
      : null
  }
}

export class SupportHostClient {
  readonly baseUrl: string

  constructor(baseUrl = '/api') {
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
      const error = typeof payload === 'object' && payload !== null
        ? payload as ErrorPayload
        : null
      throw new SupportHostError(
        error?.error ?? `Ensync support request failed (${response.status}).`,
        response.status,
        payload,
      )
    }
    return payload as T
  }

  status() {
    return this.request<SupportAvailability>('/support/status')
  }

  preview(request: SupportPreviewRequest) {
    return this.request<SupportPreviewResponse>('/support/preview', {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  prepareGitHubIssue(report: SupportReport) {
    return this.request<PreparedGitHubIssue>('/support/github-issue', {
      method: 'POST',
      body: JSON.stringify({ report, reviewed: true }),
    })
  }

  repair(request: SupportRepairRequest) {
    return this.request<SupportRepairResponse>('/support/repair', {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }
}

export function markSupportReportReviewed(
  report: SupportReport,
  reviewedAt = new Date().toISOString(),
): SupportReport {
  return {
    ...report,
    review: {
      ...report.review,
      reviewedAt,
      externalSubmission: false,
    },
  }
}

export function supportReportFileName(report: SupportReport) {
  const date = report.ticket.createdAt.slice(0, 10) || 'report'
  const safeId = report.ticket.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'ticket'
  return `ensync-support-${date}-${safeId}.json`
}

export function downloadSupportReport(report: SupportReport) {
  if (!report.review.reviewedAt) {
    throw new Error('Review the support report before downloading it.')
  }
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = supportReportFileName(report)
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function buildAiRepairPrompt(report: SupportReport) {
  if (!report.review.reviewedAt) {
    throw new Error('Review the support report before starting an AI repair task.')
  }
  return [
    'Investigate and fix this reported Ensync bug in the currently focused project.',
    'Use the project as the strict context boundary. Reproduce and verify the issue before claiming it is fixed.',
    'The attached report was explicitly reviewed by the user. Its diagnostics automatically collect no chat transcript, secrets, file contents, absolute paths, environment variables, or command output. The user-entered summary and description are included as written.',
    '',
    JSON.stringify(report, null, 2),
  ].join('\n')
}

export const supportHost = new SupportHostClient()

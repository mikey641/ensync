import {
  MalformedNdjsonEventError,
  readNdjsonStream,
  TruncatedNdjsonStreamError,
} from './ndjsonStream.mjs'
import { canReattachChatJob } from './chatJobReconnect.mjs'
import {
  InvalidJsonResponseError,
  readJsonResponse,
} from './jsonResponse.mjs'

export type CliProviderId =
  | 'claude'
  | 'codex'
  | 'kimi'
  | 'antigravity'
  | 'jules'
  | 'copilot'
  | 'cursor'
  | 'kiro'
  | 'qoder'
  | 'codebuddy'
  | 'droid'
  | 'auggie'
  | 'amp'
  | 'gitlab_duo'
  | 'oz'
  | 'junie'
  | 'ollama'

export type AuthenticationState =
  | 'authenticated'
  | 'not_authenticated'
  | 'not_required'
  | 'unknown'
  | 'unavailable'

export type ConnectionState =
  | 'ready'
  | 'needs_authentication'
  | 'installed_unverified'
  | 'checking_failed'
  | 'unavailable'

export type ProviderAuthentication = {
  state: AuthenticationState
  method: string | null
  accountLogin?: string | null
  reason: string
  source: 'cli'
  checkedAt: string
  exactPlan?: string | null
}

export type ProviderUsage = {
  availability: 'partial' | 'unavailable'
  source: 'cli' | 'unavailable'
  kind: 'subscription_quota' | 'session_only' | 'local_runtime' | 'unavailable'
  plan: string | null
  model: string | null
  usedPercent: number | null
  remainingPercent: number | null
  resetAt: string | null
  /** Exact provider-rendered reset schedule when no absolute timestamp is exposed. */
  resetLabel?: string | null
  /** Provider-reported quota window associated with the reset schedule. */
  resetWindow?: string | null
  checkedAt: string
  details: Array<{ label: string; value: string }>
  reason: string
  /** True when this refresh's probe failed and the Host kept the previous verified reading. */
  stale?: boolean
}

export type CliModel = {
  id: string
  displayName: string
  isDefault: boolean
}

export type AgentCoordinationPolicy = {
  policy: 'ensync_agent_coordination_v1'
  delivery: 'ensync_prompt'
}

export type CliProviderStatus = {
  id: CliProviderId
  name: string
  command: string
  installed: boolean
  executable: string | null
  version: string | null
  connectionState: ConnectionState
  authentication: ProviderAuthentication
  usage: ProviderUsage
  availableModels: CliModel[]
  canConnect: boolean
  connectReason: string | null
  canUpdate: boolean
  updateStrategy: 'ensync_command' | 'provider_automatic' | 'official_guide'
  updateReason: string
  routeKind: 'subscription' | 'local'
  chatExecution: 'supported' | 'discovery_only'
  setupKind: 'login_command' | 'interactive_onboarding' | 'none'
  documentationUrl: string | null
  catalogReason: string
  agentCoordination: AgentCoordinationPolicy
  checkedAt: string
}

export type ProviderStatusesResponse = {
  providers: CliProviderStatus[]
  checkedAt: string
}

export type UsageStatus = Pick<
  CliProviderStatus,
  'id' | 'name' | 'installed' | 'connectionState'
> & ProviderUsage

export type UsageResponse = {
  providers: UsageStatus[]
  checkedAt: string
}

export type ConnectResponse = {
  started: boolean
  launchMode: 'terminal' | 'manual'
  reason?: string
  command: {
    executable: string
    args: string[]
    display: string
  }
  message: string
}

export type ProviderUpdateResponse = ConnectResponse & {
  previousVersion: string | null
  deduplicated?: boolean
}

export type ProjectInstructionAdapter = {
  provider: 'codex' | 'claude'
  name: string
  file: 'AGENTS.md' | 'CLAUDE.md'
}

export type ProjectInspection = {
  id: string
  name: string
  path: string
  host: 'local'
  context: {
    relayDirectory: boolean
    files: string[]
    featureFiles: string[]
    truncated: boolean
    error: string | null
    instructionAdapters: ProjectInstructionAdapter[]
  }
  inspectedAt: string
}

export type LocalFileDisplay =
  | {
    status: 'ok'
    path: string
    name: string
    text: string
    bytes: number
    truncated: boolean
    language: string | null
  }
  | {
    status: 'invalid' | 'missing' | 'directory' | 'binary' | 'unreadable'
    path: string
    name: string
    message: string
  }

export type GitRemote = {
  name: string
  fetchUrls: string[]
  pushUrls: string[]
}

export type GitStatus = {
  repositoryPath: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number | null
  behind: number | null
  dirty: boolean
  changedFiles: number
  remotes: GitRemote[]
  preferredRemote: string | null
  productionBranch: string | null
  productionBranchSource: 'remote' | 'unavailable'
  checkedAt: string
}

export type GitConnection = {
  remote: string
  connected: true
  defaultBranch: string | null
  authentication: 'existing_git_credentials'
  message: string
  checkedAt: string
}

export type GitPushMode = 'current_branch' | 'production'

export type GitPushResult = {
  push: {
    mode: GitPushMode
    remote: string
    sourceBranch: string
    targetBranch: string
    completedAt: string
  }
  git: GitStatus
}

export interface GitUnlandedBranch {
  branch: string
  head: string
  aheadCount: number
  changedFiles: number
  lastCommittedAt: string | null
  lastSubject: string | null
}

export interface GitUnlandedResult {
  repositoryPath: string
  baseline: { branch: string | null; head: string }
  branches: GitUnlandedBranch[]
  checkedAt: string
}

export interface GitLandResult {
  land: { branch: string; mergedInto: string; mergeHead: string; completedAt: string }
  git: GitStatus
}

export type ChatProviderId = Extract<CliProviderId, 'codex' | 'claude' | 'droid'>
export type ChatModelEffort = 'low' | 'medium' | 'high' | 'max'

export type ChatRunRequest = {
  provider: ChatProviderId
  projectPath: string
  /** Stable conversation identity used to reuse one protected Git worktree. */
  workspaceKey: string
  prompt: string
  /** Absolute local file paths explicitly attached by the user. */
  attachments?: string[]
  sessionId?: string | null
  model?: string | null
  effort?: ChatModelEffort | null
  timeoutMs?: number
}

export type ChatRunUsage = {
  source: 'cli'
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
}

export type ChatOutputRecovery = {
  applied: true
  normalizedLineCount: number
  discardedLineCount: number
}

export type ChatWorkspaceBaselineConflict = {
  baselineSha: string
  files: string[]
  reason: string
}

export type ChatRunWorkspace = {
  path: string
  repositoryPath: string
  branch: string
  reused: boolean
  /** A cleanly aborted baseline merge that Ensync will retry during landing. */
  baselineConflict?: ChatWorkspaceBaselineConflict | null
  gitBefore: {
    branch: string
    head: string
    dirty: boolean
    changedFiles: number
    checkedAt: string
  }
}

export type ChatRunResponse = {
  provider: ChatProviderId
  /** Canonical user-selected project path; provider execution uses workspace.path. */
  projectPath: string
  /** Protected local Git worktree, or null for execution targets without local isolation. */
  workspace?: ChatRunWorkspace | null
  response: string
  sessionId: string | null
  /** Exact model reported by the CLI, or null when the CLI does not report one. */
  model: string | null
  /** The model alias/name requested by the user, kept separate from CLI-reported model data. */
  requestedModel: string | null
  /** The strict effort override requested for the provider's default model, or null. */
  requestedEffort: ChatModelEffort | null
  /** Exact per-run token counts reported by the CLI, or null. Never estimated. */
  usage: ChatRunUsage | null
  /** Bounded Host repair of provider protocol framing; never a replay of the task. */
  outputRecovery?: ChatOutputRecovery | null
  durationMs: number
  completedAt: string
}

/** One choice the provider offered; `description` exists only where the provider supplied one. */
export type ProviderQuestionOption = {
  label: string
  description: string | null
  /** The provider's own outcome for a permission choice; null for a questionnaire. */
  value: string | null
}

export type ProviderQuestion = {
  /** Provider-assigned position; an answer names this and never re-sends question text. */
  index: number
  /** `permission` is an approval of a tool call: one of the offered outcomes, never typed words. */
  kind: 'question' | 'permission'
  header: string
  question: string
  multiSelect: boolean
  options: ProviderQuestionOption[]
}

export type PendingProviderQuestion = {
  questionId: string
  provider: ChatProviderId
  questions: ProviderQuestion[]
  askedAt: string
}

export type ChatExecutionEvent =
  | {
      /** The provider paused its turn to ask the person something. */
      type: 'question'
      provider: ChatProviderId
      questionId: string
      questions: ProviderQuestion[]
      at: string
      sequence?: number
    }
  | {
      /** The question left the queue: answered here, or cancelled when the run ended. */
      type: 'question_resolved'
      provider: ChatProviderId
      questionId: string
      cancelled: boolean
      answers: { index: number; question: string; answer: string; value?: string }[]
      at: string
      sequence?: number
    }
  | {
      type: 'notice'
      message: string
      code?: 'project_write_lock_waiting' | 'workspace_write_lock_waiting' | 'project_workspace_ready' | string
      workspace?: {
        path: string
        branch: string
        baselineConflict?: ChatWorkspaceBaselineConflict | null
      }
      overlap?: {
        peerBranch: string
        state: 'detected' | 'cleared'
        source: 'active' | 'unlanded'
        paths: string[]
        totalCount: number
      }
      at: string
      /** Monotonic Host job sequence used to resume a detached stream without duplication. */
      sequence?: number
    }
  | {
      /** Provider-authored, CLI-visible progress text; never hidden reasoning. */
      type: 'note'
      provider: ChatProviderId
      text: string
      redacted: boolean
      at: string
      sequence?: number
    }
  | {
      type: 'started'
      provider: ChatProviderId
      cwd: string
      command: string
      at: string
      sequence?: number
    }
  | {
      type: 'output'
      stream: 'stdout' | 'stderr'
      text: string
      redacted: boolean
      at: string
      sequence?: number
    }
  | {
      type: 'finished'
      outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted'
      message: string
      code: string | null
      safeToRetry: boolean
      at: string
      sequence?: number
    }

type ChatStreamCompletedEvent = {
  type: 'completed'
  result: ChatRunResponse
  at: string
  sequence?: number
}

type ChatStreamErrorEvent = {
  type: 'error'
  error: string
  code: string
  status: number
  safeToRetry: boolean
  at: string
  sequence?: number
}

type ChatStreamCancelledEvent = {
  type: 'cancelled'
  message: string
  code: 'run_cancelled'
  status: number
  safeToRetry: false
  at: string
  sequence?: number
}

export type ChatJobKind = 'local' | 'ssh'

export type ChatJobSnapshot = {
  id: string
  kind: ChatJobKind
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt: string | null
  firstSequence: number
  lastSequence: number
  providerProcessStarted: boolean
  /** Host-observed active Codex turn readiness; never inferred from job state. */
  steerable: boolean
  /** Questions the live run is blocked on, so a reconnecting window recovers them. */
  pendingQuestions: PendingProviderQuestion[]
}

export type OccupiedChatJobOwner = {
  jobId: string | null
  provider: string | null
  targetKind: ChatJobKind | null
  startedAt: string | null
  providerProcessStarted: boolean
  steerable: boolean
  nativeWorkspaceId: string | null
  /** Present only when this Host still retains the exact live job in memory. */
  turnId: string | null
}

export type ChatJobNavigation = {
  nativeWorkspaceId: string | null
  projectId: string
  chatId: string
  turnId: string
}

export type ChatJobAdmission =
  | { disposition: 'started' | 'reconnected'; job: ChatJobSnapshot }
  | { disposition: 'occupied'; owner: OccupiedChatJobOwner }

export class ChatJobOccupiedError extends Error {
  owner: OccupiedChatJobOwner

  constructor(owner: OccupiedChatJobOwner) {
    super('Another run is already active in this conversation.')
    this.name = 'ChatJobOccupiedError'
    this.owner = owner
  }
}

export type ChatSteerResponse = {
  job: ChatJobSnapshot
  delivery: { turnId: string }
}

export type ChatQuestionAnswerResponse = {
  job: ChatJobSnapshot
  answer: {
    id: string
    cancelled: boolean
    answers: { index: number; question: string; answer: string; value?: string }[]
  }
}

type ErrorPayload = { error?: string; code?: string; safeToRetry?: boolean }

export class EnsyncHostError extends Error {
  status: number
  payload: unknown
  code: string | null
  safeToRetry: boolean

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = 'EnsyncHostError'
    this.status = status
    this.payload = payload
    this.code =
      typeof payload === 'object'
      && payload !== null
      && typeof (payload as ErrorPayload).code === 'string'
        ? (payload as ErrorPayload).code ?? null
        : null
    this.safeToRetry =
      typeof payload === 'object'
      && payload !== null
      && (payload as ErrorPayload).safeToRetry === true
  }
}

export class EnsyncHostClient {
  readonly baseUrl: string

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async jsonPayload(response: Response): Promise<unknown> {
    try {
      return await readJsonResponse(response)
    } catch (error) {
      if (!(error instanceof InvalidJsonResponseError)) throw error
      throw new EnsyncHostError(
        'Ensync Host returned a non-JSON response. The operation was not retried because its completion state is unknown.',
        response.ok ? 502 : response.status,
        { code: 'invalid_host_response', safeToRetry: false },
      )
    }
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
    const payload = await this.jsonPayload(response)
    if (!response.ok) {
      const errorPayload =
        typeof payload === 'object' && payload !== null ? (payload as ErrorPayload) : null
      const message = errorPayload?.error
        ? errorPayload.error
        : `Ensync Host request failed (${response.status}).`
      throw new EnsyncHostError(message, response.status, payload)
    }
    return payload as T
  }

  providers(refresh = false) {
    return this.request<ProviderStatusesResponse>(`/providers${refresh ? '?refresh=1' : ''}`)
  }

  provider(id: CliProviderId, refresh = false) {
    return this.request<{ provider: CliProviderStatus }>(
      `/providers/${id}/status${refresh ? '?refresh=1' : ''}`,
    )
  }

  usage(refresh = false) {
    return this.request<UsageResponse>(`/usage${refresh ? '?refresh=1' : ''}`)
  }

  connect(id: CliProviderId, launch = true) {
    return this.request<ConnectResponse>(`/providers/${id}/connect`, {
      method: 'POST',
      body: JSON.stringify({ launch }),
    })
  }

  updateProvider(id: CliProviderId, launch = true, trigger: 'manual' | 'automatic' = 'manual') {
    return this.request<ProviderUpdateResponse>(`/providers/${id}/update`, {
      method: 'POST',
      body: JSON.stringify({ launch, trigger }),
    })
  }

  currentProject() {
    return this.request<{ project: ProjectInspection }>('/projects/current')
  }

  inspectProject(path: string) {
    return this.request<{ project: ProjectInspection }>('/projects/inspect', {
      method: 'POST',
      body: JSON.stringify({ path }),
    })
  }

  readLocalFile(path: string) {
    return this.request<{ file: LocalFileDisplay }>('/local-file', {
      method: 'POST',
      body: JSON.stringify({ path }),
    })
  }

  cloneRepository(repositoryUrl: string, destinationPath: string) {
    return this.request<{ project: ProjectInspection; git: GitStatus }>('/git/clone', {
      method: 'POST',
      body: JSON.stringify({ repositoryUrl, destinationPath }),
    })
  }

  gitStatus(projectPath: string) {
    return this.request<{ git: GitStatus }>('/git/status', {
      method: 'POST',
      body: JSON.stringify({ projectPath }),
    })
  }

  verifyGitRemote(projectPath: string, remote: string) {
    return this.request<{ connection: GitConnection }>('/git/verify-remote', {
      method: 'POST',
      body: JSON.stringify({ projectPath, remote }),
    })
  }

  pushGit(input: {
    projectPath: string
    remote: string
    mode: GitPushMode
    productionBranch?: string
    allowProduction?: boolean
    confirmation?: string
  }) {
    return this.request<GitPushResult>('/git/push', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  gitUnlanded(projectPath: string) {
    return this.request<{ unlanded: GitUnlandedResult }>('/git/unlanded', {
      method: 'POST',
      body: JSON.stringify({ projectPath }),
    })
  }

  landGitBranch(input: { projectPath: string; branch: string }) {
    return this.request<GitLandResult>('/git/land', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  runChat(request: ChatRunRequest, signal?: AbortSignal) {
    return this.request<ChatRunResponse>('/chat/run', {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
    })
  }

  startChatJob(
    jobId: string,
    kind: ChatJobKind,
    request: object,
    navigation?: ChatJobNavigation,
  ) {
    return this.request<ChatJobAdmission>('/chat/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobId, kind, request, navigation }),
    })
  }

  chatJob(jobId: string) {
    return this.request<{ job: ChatJobSnapshot }>(`/chat/jobs/${encodeURIComponent(jobId)}`)
  }

  cancelChatJob(jobId: string) {
    return this.request<{ job: ChatJobSnapshot }>(`/chat/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    })
  }

  steerChatJob(jobId: string, prompt: string, idempotencyKey: string, attachments: string[] = []) {
    return this.request<ChatSteerResponse>(`/chat/jobs/${encodeURIComponent(jobId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ prompt, attachments, idempotencyKey }),
    })
  }

  /**
   * Delivers the person's answer to the live provider run that is waiting on it.
   * A permission answer carries `value`, the provider's own outcome, because a
   * label alone is not something the provider would accept.
   */
  answerChatQuestion(jobId: string, answer: { questionId: string; answers?: { index: number; answer: string; value?: string }[]; cancelled?: boolean }) {
    return this.request<ChatQuestionAnswerResponse>(`/chat/jobs/${encodeURIComponent(jobId)}/answer`, {
      method: 'POST',
      body: JSON.stringify(answer),
    })
  }

  probeAttachmentPaths(paths: string[]) {
    return this.request<{ results: { path: string; readable: boolean }[] }>('/chat/attachments/probe', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    })
  }

  storeChatAttachment(name: string, bytes: ArrayBuffer) {
    return this.request<{ attachment: { path: string; name: string } }>(
      `/chat/attachments?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    )
  }

  async attachChatJob(
    jobId: string,
    onEvent: (event: ChatExecutionEvent) => void,
    signal?: AbortSignal,
    afterSequence = 0,
  ): Promise<ChatRunResponse> {
    let cancellationReported = false
    let result: ChatRunResponse | null = null
    let terminalError: EnsyncHostError | null = null
    const cancelledError = () => new EnsyncHostError(
      'Run stopped by user. The provider process was terminated.',
      499,
      { code: 'run_cancelled', safeToRetry: false },
    )
    const reportCancellation = () => {
      if (cancellationReported) return
      cancellationReported = true
      onEvent({
        type: 'finished',
        outcome: 'cancelled',
        message: 'Run stopped by user. The provider process was terminated.',
        code: 'run_cancelled',
        safeToRetry: false,
        at: new Date().toISOString(),
      })
    }
    const requestCancellation = () => {
      void this.cancelChatJob(jobId).catch(() => {})
    }
    if (signal?.aborted) {
      requestCancellation()
      reportCancellation()
      throw cancelledError()
    }
    signal?.addEventListener('abort', requestCancellation, { once: true })

    try {
      const response = await fetch(
        `${this.baseUrl}/chat/jobs/${encodeURIComponent(jobId)}/stream?after=${Math.max(0, afterSequence)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/x-ndjson' },
          signal,
        },
      )
      if (!response.ok) {
        const payload = await this.jsonPayload(response)
        const message = typeof payload === 'object' && payload !== null && typeof (payload as ErrorPayload).error === 'string'
          ? (payload as ErrorPayload).error!
          : `Ensync Host request failed (${response.status}).`
        throw new EnsyncHostError(message, response.status, payload)
      }
      if (!response.body) throw new EnsyncHostError('Ensync Host returned no retained job stream.', 502, {})

      const readEvent = (value: unknown) => {
        const event = value as ChatExecutionEvent | ChatStreamCompletedEvent | ChatStreamErrorEvent | ChatStreamCancelledEvent
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
          throw new EnsyncHostError('Ensync Host returned an invalid retained job event.', 502, event)
        }
        if (event.type === 'started' || event.type === 'output' || event.type === 'notice' || event.type === 'note' || event.type === 'question' || event.type === 'question_resolved') {
          onEvent(event)
        } else if (event.type === 'completed') {
          result = event.result
          onEvent({
            type: 'finished',
            outcome: 'completed',
            message: 'CLI process completed successfully.',
            code: null,
            safeToRetry: false,
            at: event.at,
            sequence: event.sequence,
          })
        } else if (event.type === 'error') {
          onEvent({
            type: 'finished',
            outcome: 'failed',
            message: event.error,
            code: event.code,
            safeToRetry: event.safeToRetry,
            at: event.at,
            sequence: event.sequence,
          })
          terminalError = new EnsyncHostError(event.error, event.status, event)
        } else if (event.type === 'cancelled') {
          reportCancellation()
          terminalError = new EnsyncHostError(event.message, event.status, event)
        } else {
          throw new EnsyncHostError('Ensync Host returned an unknown retained job event.', 502, event)
        }
      }
      await readNdjsonStream(response.body, readEvent)
      if (terminalError) throw terminalError
      if (!result) {
        throw new EnsyncHostError(
          'The retained Ensync Host job stream ended before a terminal result was available.',
          502,
          { code: 'chat_job_stream_disconnected', safeToRetry: false },
        )
      }
      return result
    } catch (error) {
      if (signal?.aborted) {
        reportCancellation()
        throw cancelledError()
      }
      if (error instanceof EnsyncHostError) throw error
      if (error instanceof RangeError || error instanceof MalformedNdjsonEventError) {
        throw new EnsyncHostError(
          error instanceof RangeError
            ? 'Ensync Host returned an oversized retained job event.'
            : 'Ensync Host returned a malformed retained job event.',
          502,
          { code: 'invalid_chat_job_stream', safeToRetry: false },
        )
      }
      throw new EnsyncHostError(
        error instanceof TruncatedNdjsonStreamError
          ? 'The retained Ensync Host job stream ended during an event.'
          : 'The retained Ensync Host job stream disconnected.',
        502,
        { code: 'chat_job_stream_disconnected', safeToRetry: false },
      )
    } finally {
      signal?.removeEventListener('abort', requestCancellation)
    }
  }

  async runChatJob(
    jobId: string,
    kind: ChatJobKind,
    request: object,
    onEvent: (event: ChatExecutionEvent) => void,
    signal?: AbortSignal,
    navigation?: ChatJobNavigation,
  ): Promise<ChatRunResponse> {
    const admission = await this.startChatJob(jobId, kind, request, navigation)
    if (admission.disposition === 'occupied') throw new ChatJobOccupiedError(admission.owner)
    let cursor = 0
    for (;;) {
      try {
        return await this.attachChatJob(jobId, (event) => {
          if (typeof event.sequence === 'number') cursor = Math.max(cursor, event.sequence)
          onEvent(event)
        }, signal, cursor)
      } catch (error) {
        if (signal?.aborted) throw error
        const reconnectable = !(error instanceof EnsyncHostError)
          || canReattachChatJob(error)
        if (!reconnectable) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 750))
      }
    }
  }

  async runChatStream(
    request: ChatRunRequest,
    onEvent: (event: ChatExecutionEvent) => void,
    signal?: AbortSignal,
  ): Promise<ChatRunResponse> {
    let cancellationReported = false
    const cancelledError = () => new EnsyncHostError(
      'Run stopped by user. The provider process was terminated.',
      499,
      { code: 'run_cancelled', safeToRetry: false },
    )
    const reportCancellation = () => {
      if (cancellationReported) return
      cancellationReported = true
      onEvent({
        type: 'finished',
        outcome: 'cancelled',
        message: 'Run stopped by user. The provider process was terminated.',
        code: 'run_cancelled',
        safeToRetry: false,
        at: new Date().toISOString(),
      })
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/run/stream`, {
        method: 'POST',
        headers: {
          Accept: 'application/x-ndjson',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal,
      })
      if (!response.ok) {
        const payload = await this.jsonPayload(response)
        const message = typeof payload === 'object' && payload !== null && typeof (payload as ErrorPayload).error === 'string'
          ? (payload as ErrorPayload).error!
          : `Ensync Host request failed (${response.status}).`
        throw new EnsyncHostError(message, response.status, payload)
      }
      if (!response.body) throw new EnsyncHostError('Ensync Host returned no execution stream.', 502, {})

      let result: ChatRunResponse | null = null
      const readEvent = (value: unknown) => {
        const event = value as ChatExecutionEvent | ChatStreamCompletedEvent | ChatStreamErrorEvent | ChatStreamCancelledEvent
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
          throw new EnsyncHostError('Ensync Host returned an invalid execution event.', 502, event)
        }
        if (event.type === 'started' || event.type === 'output' || event.type === 'notice' || event.type === 'note' || event.type === 'question' || event.type === 'question_resolved') {
          onEvent(event)
        } else if (event.type === 'completed') {
          result = event.result
          onEvent({
            type: 'finished',
            outcome: 'completed',
            message: 'CLI process completed successfully.',
            code: null,
            safeToRetry: false,
            at: event.at,
          })
        } else if (event.type === 'error') {
          onEvent({
            type: 'finished',
            outcome: 'failed',
            message: event.error,
            code: event.code,
            safeToRetry: event.safeToRetry,
            at: event.at,
          })
          throw new EnsyncHostError(event.error, event.status, event)
        } else if (event.type === 'cancelled') {
          reportCancellation()
          throw new EnsyncHostError(event.message, event.status, event)
        } else {
          throw new EnsyncHostError('Ensync Host returned an unknown execution event.', 502, event)
        }
      }
      await readNdjsonStream(response.body, readEvent)
      if (!result) throw new EnsyncHostError('Ensync Host stream ended without a completion event.', 502, {})
      return result
    } catch (error) {
      if (signal?.aborted) {
        reportCancellation()
        throw cancelledError()
      }
      if (error instanceof EnsyncHostError) throw error
      if (error instanceof RangeError || error instanceof MalformedNdjsonEventError) {
        throw new EnsyncHostError(
          error instanceof RangeError
            ? 'Ensync Host returned an oversized execution event.'
            : 'Ensync Host returned a malformed execution event.',
          502,
          { code: 'invalid_execution_stream', safeToRetry: false },
        )
      }
      throw new EnsyncHostError(
        error instanceof TruncatedNdjsonStreamError
          ? 'The Ensync Host execution stream ended during an event.'
          : 'The Ensync Host execution stream disconnected before a final result.',
        502,
        { code: 'execution_stream_disconnected', safeToRetry: false },
      )
    }
  }
}

export const ensyncHost = new EnsyncHostClient()

// Compatibility aliases keep integrations built against the prototype name working.
export const RelayHostError = EnsyncHostError
export const RelayHostClient = EnsyncHostClient
export const relayHost = ensyncHost

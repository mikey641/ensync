export type ProviderId =
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

export type Provider = {
  id: ProviderId
  name: string
  model: string | null
  availableModels: Array<{ id: string; displayName: string; isDefault: boolean }>
  color: string
  mark: string
  connected: boolean
  /** Exact Host authentication result; unknown is not the same as logged out. */
  authenticationState?: 'authenticated' | 'not_authenticated' | 'not_required' | 'unknown' | 'unavailable'
  /** Exact account login reported by a verified CLI status surface. */
  accountLogin?: string | null
  installed: boolean | null
  /** Exact version text reported by the installed CLI. */
  version?: string | null
  usage: number | null
  status: string
  plan: string | null
  usageSource: 'cli' | 'unavailable'
  usageKind: 'subscription_quota' | 'session_only' | 'local_runtime' | 'unavailable'
  usageDetails: Array<{ label: string; value: string }>
  resetsIn: string | null
  /** Exact CLI-rendered schedule retained when the CLI omits an absolute timestamp. */
  resetLabel?: string | null
  /** Provider-reported quota window associated with the reset schedule. */
  resetWindow?: string | null
  usageReason: string
  canConnect: boolean
  /** True only when Ensync has a fixed, verified provider-owned self-update command. */
  canUpdate?: boolean
  /** How this installed provider receives updates without inferring its install method. */
  updateStrategy?: 'ensync_command' | 'provider_automatic' | 'official_guide'
  updateReason?: string | null
  routeKind: 'subscription' | 'local'
  chatExecution: 'supported' | 'discovery_only'
  setupKind: 'login_command' | 'interactive_onboarding' | 'none'
  documentationUrl: string | null
  catalogReason: string
  checkedAt: string | null
}

export type Message = {
  id: string
  role: 'user' | 'agent'
  content: string
  time: string
  /** Exact source timestamp retained by an explicit transcript import. */
  timestamp?: string | null
  provider?: ProviderId
  turnId?: string
  deliveryStatus?: 'queued' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  /** Exact model reported by the completed CLI, or null when the CLI did not report one. */
  model?: string | null
  /** Friendly effort tier requested for this run, or null when provider defaults were used. */
  sizeTier?: ModelSizeTier | null
  executionTarget?: string
  sessionResumable?: boolean
  /** Local files explicitly attached by the user for this turn. */
  attachments?: FileAttachment[]
}

export type FileAttachment = {
  name: string
  path: string
}

export type ContinuationState = {
  turnId: string
  status: 'completed' | 'blocked' | 'cancelled' | 'reconciliation_required'
  /** A user stop terminated this turn; partial provider activity may still require reconciliation. */
  termination?: 'cancelled' | 'interrupted'
  reconciliationRequired?: boolean
  provider: ProviderId
  model: string | null
  sizeTier: ModelSizeTier | null
  executionTarget: string
  sessionResumable: boolean
  attemptedProviders: ProviderId[]
  fallbackReason: string | null
  completedAt: string
  gitBefore: { branch: string | null; dirty: boolean; changedFiles: number; checkedAt: string } | null
  gitAfter: { branch: string | null; dirty: boolean; changedFiles: number; checkedAt: string } | null
  gitReason: string | null
  /** Provider-authored handoff retained for future agents, never rendered as message text. */
  semanticSummary?: string | null
  /** Host-managed local Git worktree used for this conversation. */
  workspace?: {
    path: string
    branch: string
  } | null
}

export type Chat = {
  id: string
  /** Local provider-neutral key for this conversation's protected agent worktree. */
  agentWorkspaceKey?: string
  projectId: string
  title: string
  subtitle: string
  group: 'Today' | 'Yesterday' | 'Previous 7 days'
  provider: ProviderId
  /** Auto follows the persisted fallback priority and skips providers with verified exhausted usage. */
  providerMode?: 'auto' | 'fixed'
  /** Null/undefined means omit the CLI model flag and use that provider's current default. */
  model?: string | null
  /** Friendly effort tier over the provider's default model; null/undefined omits the effort flag. */
  sizeTier?: ModelSizeTier | null
  messages: Message[]
  /** Stable Host-managed worktree used by this conversation's local agent runs. */
  workspace?: {
    path: string
    branch: string
  } | null
  /** Non-secret identity used to update one explicitly imported external conversation without duplication. */
  importSource?: {
    kind: 'codex_session'
    sessionId: string
    projectPath: string
    sourceFingerprint: string
    transcriptSha256: string
    transcriptBytes: number
    historySha256: string
    historyBytes: number
    messageIds: string[]
    startedAt: string | null
    lastVisibleAt: string | null
  }
  continuation?: ContinuationState
  pinned?: boolean
}

export type ModelSizeTier = 'small' | 'medium' | 'large' | 'xl'

export type WorkspaceTab = {
  id: string
  chatId: string
}

export type NewTabPlacement = 'adjacent' | 'end'

/** How open conversations share the workspace. */
export type ConversationLayoutMode = 'tabs' | 'split'

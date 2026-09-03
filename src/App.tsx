import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  Copy,
  Cloud,
  FileText,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitFork,
  History,
  Layers3,
  LifeBuoy,
  LockKeyhole,
  LogOut,
  Menu,
  MessageSquareText,
  Paperclip,
  Plus,
  RotateCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Smartphone,
  TerminalSquare,
  UserRound,
  Wifi,
  X,
} from 'lucide-react'
import { defaultProviders, initialChats } from './data'
import type { Chat, ConversationLayoutMode, FileAttachment, ModelSizeTier, NewTabPlacement, Provider, ProviderId, WorkspaceTab } from './types'
import { DisplayPreferences, useDisplayPreferences } from './display-preferences'
import {
  CompletionNotificationPreferences,
  primeCompletionNotifications,
  useCompletionNotifications,
} from './completion-notifications'
import { SplitWorkspace, type SplitWorkspaceLayout } from './components/SplitWorkspace'
import { ChatContextHeader } from './components/ChatContextHeader'
import { MessageContent } from './components/MessageContent'
import { isLongMessageContent } from './lib/messageContent.mjs'
import { useChatAutoScroll } from './components/useChatAutoScroll'
import { ResizableSidebar, readResizableSidebarPreferences } from './components/ResizableSidebar'
import { RemoteSshSetup } from './components/RemoteSshSetup'
import { TelegramSetup } from './components/TelegramSetup'
import { VirtualBoxSetup } from './components/VirtualBoxSetup'
import { GitWorkflowModal } from './components/GitWorkflowModal'
import { FileViewerModal } from './components/FileViewerModal'
import { NativeUpdatePreferences } from './components/NativeUpdatePreferences'
import { SupportDesk } from './components/SupportDesk'
import { UIVisibilityPreferences, useUIVisibility, type UIVisibilityState } from './ui-visibility'
import {
  ensyncHost,
  ChatJobOccupiedError,
  EnsyncHostError,
  type ChatProviderId,
  type ChatExecutionEvent,
  type ChatRunResponse,
  type CliProviderStatus,
  type GitStatus,
  type ProjectInspection,
} from './lib/relayHost'
import { createTelegramHostClient } from './telegram-client'
import {
  remoteSshHost,
  RemoteSshClientError,
  type RemoteSshConnectionInput,
  type RemoteSshProbe,
} from './lib/remoteSsh'
import { supportRepairHost } from './lib/supportRepairHost'
import {
  accountSyncHost,
  type AccountSyncStatus,
} from './lib/accountSyncHost'
import {
  mergeAccountWorkspace,
  prepareAccountWorkspace,
} from './lib/accountWorkspaceSync.mjs'
import {
  DEFAULT_FALLBACK_PROVIDER_ORDER,
  conversationProviderId,
  normalizeFallbackProviderOrder,
  orderedAutomaticProviders,
  selectAutomaticFallbackProviderAfterRefresh,
  selectAutomaticProvider,
} from './lib/automaticRouting.mjs'
import {
  resolveFallbackProviderOrder,
  writeStoredFallbackProviderOrder,
} from './lib/automaticRoutingPreferences.mjs'
import { buildAutoContextPrompt } from './lib/autoContextPrompt.mjs'
import { appendFallbackReason, safeFallbackProof } from './lib/safeFallback.mjs'
import { retryableFailedTurn } from './lib/failedTurnRetry.mjs'
import {
  chatRunPreferences,
  effortForModelSize,
  sizeForModelEffort,
} from './lib/chatPreferences.mjs'
import {
  chooseNativeProjectFolder,
  nativeProjectFolderPickerAvailable,
} from './lib/nativeProjectFolder.mjs'
import { createChatRunRegistry } from './lib/chatRunRegistry.mjs'
import { createChatRunCancellationRegistry } from './lib/chatRunCancellation.mjs'
import {
  adoptReconnectableHostJobState,
  beginRunAfterPredecessorFingerprint,
  canonicalPredecessorTranscript,
  createOccupiedJobProbeCoordinator,
  predecessorTranscriptFingerprint,
  retryableOccupiedJobProbes,
  runningHostJobCandidates,
  shouldSuppressOccupiedJobProbe,
} from './lib/hostJobRecovery.mjs'
import { extractEnsyncContinuation } from './lib/ensyncContinuation.mjs'
import { chatAutoScrollContentRevision } from './lib/chatAutoScroll.mjs'
import { nextProviderRefreshDelay } from './lib/providerRefreshPolicy.mjs'
import { providerResetText } from './lib/providerResetText.mjs'
import { PROJECT_COLORS, projectColor } from './lib/projectColors.mjs'
import {
  conversationWorkspaceKey,
  resolveConversationWorkspaceKey,
} from './lib/conversationWorkspaceKey.mjs'
import {
  acknowledgeAgentUpdateReminder,
  agentUpdateDue,
  readAgentUpdatePreferences,
  recordAgentUpdateMaintenance,
  writeAgentUpdatePreferences,
  type AgentUpdateMode,
  type AgentUpdatePreferences,
} from './lib/agentUpdatePreferences.mjs'
import {
  nextWorkingElapsedDelay,
  workingElapsedLabel,
} from './lib/workingElapsed.mjs'
import {
  appendPromptToQueue,
  approveNextQueuedPrompt,
  insertAgentReplyBeforeLaterQueued,
  liveSteerWasSafelyRejected,
  liveSteerReadyAfterEvent,
  normalizePromptQueues,
  markQueuedMessageTransferred,
  predecessorTurnIdForPrompt,
  promoteQueuedMessageToActiveTurn,
  promoteQueuedPromptToActiveTurn,
  promptQueueComposerState,
  promptQueueStatusPresentation,
  promptSubmissionMode,
  queueMayAdvanceAfterRun,
  queuedPromptCanStopAndSendNow,
  queuedPromptGate,
  removePromptFromQueue,
  transcriptMessagesBeforeTurn,
  type PromptQueues,
  type QueuedPrompt,
} from './lib/promptQueue.mjs'
import {
  activeNativeRunBindings,
  applyOccupiedJobObservation,
  commitHandoffAcceptance,
  completedNativeRunBinding,
  convertPendingTurnToOccupiedQueue,
  exactNativeFocusCanApply,
  handoffEntryForAction,
  normalizeOccupiedRuns,
  occupiedQueueSnapshotForAttempt,
  occupiedRunControls,
  reconcileQueuedMessageHandoff,
  validateTerminalQueuedMessageHandoff,
  validateQueuedMessageHandoff,
  type CompletedNativeRunBinding,
  type NativeExactRunBinding,
  type OccupiedRuns,
} from './lib/occupiedRunState.mjs'
import {
  pendingQuestionsByChat,
  pendingQuestionsFromEvents,
  questionsNeedingAlert,
  type ProviderQuestionAnswerPayload,
} from './lib/providerQuestions.mjs'
import { ProviderQuestionCard } from './components/ProviderQuestionCard'
import {
  activeTabIdAfterClose,
  insertNewConversationTab,
} from './lib/newConversationPlacement.mjs'
import {
  executionPanelOpenForChat,
  normalizeExecutionPanelOpenByChat,
  setExecutionPanelOpenForChat,
} from './lib/executionPanelPreferences.mjs'
import {
  markChatCompletionRead,
  markCompletionRead,
  unreadCompletionTabIds,
} from './lib/completionReadState.mjs'
import {
  compactWorkspaceSnapshot,
  commitWorkspaceSnapshot,
  createWorkspaceSnapshotKeys,
  INTERRUPTION_MESSAGE,
  readWorkspaceSnapshot,
  reconcileInterruptedWorkspaceState,
} from './lib/workspacePersistence.mjs'
import {
  getInitialNativeProjectLaunch,
  getNativeWorkspaceIdentity,
  getRetainedNativeWorkspaceIds,
  getRetainedNativeWorkspaces,
  isCanonicalWorkspace,
  isNativeWorkspaceIdentity,
  refreshRetainedNativeWorkspaces,
  workspaceStorageKey,
} from './lib/nativeWorkspaceIdentity.mjs'
import {
  exactNativeChatFocusCanApply,
  findReferencedOwningConversation,
  findRetainedWorkspaceForProject,
  nativeProjectPathKey,
  type ReferencedOwningConversation,
  workspaceProjectHistoryScore,
} from './lib/nativeWorkspaceRouting.mjs'
import { recoverRecentProjectHistory } from './lib/recentProjectHistory.mjs'
import { recoverArchivedProjectHistory } from './lib/archivedProjectHistory.mjs'
import {
  recoverFocusedProjectHistory,
  recoverOpenedProjectHistory,
} from './lib/openedProjectHistory.mjs'
import {
  getNativeRecentProjects,
  rememberNativeRecentProject,
  subscribeNativeRecentProjects,
  type NativeRecentProject,
} from './lib/nativeRecentProjects.mjs'
import {
  appendFileAttachments,
  messageTextWithAttachments,
  normalizeFileAttachments,
  resolveDroppedAttachments,
  visibleMessageText,
} from './lib/fileAttachments.mjs'
import { decorativeTrafficLightsVisible } from './lib/titlebar.mjs'

const STORAGE_KEY = 'ensync-workspace-v2'
const LEGACY_STORAGE_KEY = 'relay-workspace-v2'
const timeNow = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const telegramHostClient = createTelegramHostClient()
const EMPTY_ACCOUNT_SYNC_STATUS: AccountSyncStatus = {
  configured: false,
  authenticated: false,
  username: null,
  remoteRevision: null,
  lastSyncedAt: null,
  encryption: 'aes-256-gcm',
  credentialStorage: 'host_memory_only',
}

function useWorkingElapsedLabel(running: boolean, startedAt: string | null) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!running || !startedAt || workingElapsedLabel({ running: true, startedAt, nowMs: Date.now() }) === null) return
    let timer: ReturnType<typeof window.setTimeout> | null = null
    const update = () => {
      const currentTime = Date.now()
      setNowMs(currentTime)
      timer = window.setTimeout(update, nextWorkingElapsedDelay(startedAt, currentTime))
    }
    update()
    return () => {
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [running, startedAt])

  return workingElapsedLabel({ running, startedAt, nowMs })
}

function runWasCancelled(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return true
  return (error instanceof EnsyncHostError || error instanceof RemoteSshClientError)
    && error.code === 'run_cancelled'
}

function cancelledRunError() {
  return new EnsyncHostError(
    'Run stopped by user. The provider process was terminated.',
    499,
    { code: 'run_cancelled', safeToRetry: false },
  )
}

type StoredState = {
  chats: Chat[]
  tabs: WorkspaceTab[]
  activeTabId: string
  chatSessions?: Record<string, { provider: ChatProviderId; sessionId: string; targetKey?: string; syncedMessageCount?: number }>
  modelTelemetry?: ModelTelemetry[]
  projects?: RelayProject[]
  activeProjectId?: string
  placement: NewTabPlacement
  conversationLayout?: ConversationLayoutMode
  autoFallback: boolean
  autoContextSkill?: boolean
  fallbackProviderOrder?: ProviderId[]
  /** Latest completed agent-message ID the user opened, keyed by stable chat ID. */
  readCompletionByChat?: Record<string, string>
  /** User-selected CLI execution-panel visibility, keyed by stable chat ID. */
  executionPanelOpenByChat?: Record<string, boolean>
  /** Unsent text is isolated by stable chat ID and restored after relaunch. */
  drafts?: Record<string, string>
  /** Unsent local file references are isolated by stable chat ID and restored after relaunch. */
  draftAttachments?: Record<string, FileAttachment[]>
  /** Latest honest run error or recovery warning for each chat. */
  chatErrors?: Record<string, string | null>
  /** Bounded, CLI-visible event stream retained independently for each chat. */
  chatExecutionEvents?: Record<string, ChatExecutionEvent[]>
  /** Split-pane presentation keyed by stable tab IDs. */
  splitLayout?: SplitWorkspaceLayout
  /** Hideable workspace chrome committed with the rest of the workspace. */
  uiVisibility?: UIVisibilityState
  conversationSidebarWidth?: number
  /** Runs without a final Host result at the time of the last commit. */
  inFlightRuns?: Record<string, PersistedInFlightRun>
  /** Persisted same-chat FIFO prompts, including their enqueue-time routing/target choices. */
  promptQueues?: PromptQueues
  /** Bounded owner coordinates for messages admitted behind another live renderer. */
  occupiedRuns?: OccupiedRuns
  /** Hashes of explicitly merged external recovery artifacts. */
  workspaceRecoveryIds?: string[]
  /** Retired native snapshots already inspected for project-only history recovery. */
  recentProjectRecoveryIds?: string[]
  /** Exact source-prefix hashes applied by explicit external conversation imports. */
  conversationImportIds?: string[]
  /** Retired native-window project histories already merged into canonical. */
  archivedProjectRecoveryIds?: string[]
}

type PersistedInFlightRun = {
  turnId: string
  provider: ChatProviderId
  sizeTier: ModelSizeTier | null
  executionTarget: string
  attemptedProviders: ChatProviderId[]
  fallbackReason: string | null
  providerProcessStarted: boolean
  startedAt: string
  gitBefore: ReturnType<typeof continuationGit>
  /** Host-owned job identity survives renderer replacement without replaying the prompt. */
  jobId?: string
  /** Last non-terminal Host event safely reflected in the persisted execution panel. */
  lastEventSequence?: number
  projectId?: string
  projectPath?: string
  /** True only while Ensync Host has observed an active Codex provider turn. */
  liveSteerReady?: boolean
  continuityStateRequired?: boolean
  gitReason?: string
}

function readInitialStoredState(): StoredState | null {
  try {
    const identity = getNativeWorkspaceIdentity()
    const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, identity))
    const snapshot = readWorkspaceSnapshot<StoredState>(window.localStorage, { keys })
    const legacyStates = isCanonicalWorkspace(identity)
      ? [STORAGE_KEY, LEGACY_STORAGE_KEY].flatMap((key) => {
          const value = localStorage.getItem(key)
          if (!value) return []
          try {
            const state = JSON.parse(value) as StoredState
            return state && typeof state === 'object' && !Array.isArray(state) ? [state] : []
          } catch {
            return []
          }
        })
      : []
    const stored = snapshot?.state ?? legacyStates[0] ?? null
    const reconciled = stored
      ? reconcileInterruptedWorkspaceState(stored, { preserveHostJobs: true }).state
      : null
    const withRecentProjects = recoverRecentProjectHistory(reconciled, window.localStorage, {
      identity,
      retainedWorkspaceIds: getRetainedNativeWorkspaceIds(),
      legacyStates,
    }).state
    const withArchivedProjects = recoverArchivedProjectHistory(withRecentProjects, window.localStorage, {
      identity,
      retainedWorkspaceIds: getRetainedNativeWorkspaceIds(),
    }).state
    const projectLaunch = getInitialNativeProjectLaunch()
    return projectLaunch
      ? recoverOpenedProjectHistory(withArchivedProjects, window.localStorage, { projectLaunch }).state
      : withArchivedProjects
  } catch {
    return null
  }
}

type ExecutionTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; connection: RemoteSshConnectionInput; probe: RemoteSshProbe }

function remoteSubscriptionReady(provider: RemoteSshProbe['providers'][number] | undefined) {
  const method = provider?.authentication?.method?.toLowerCase() ?? ''
  return Boolean(
    provider
    && provider.directlyRunnable
    && provider.authentication?.state === 'authenticated'
    && (provider.id === 'codex'
      ? method.includes('chatgpt')
      : provider.id === 'claude'
        && ['claude.ai', 'oauth', 'subscription'].some((signal) => method.includes(signal))),
  )
}

function providersForTarget(providers: Provider[], target: ExecutionTarget): Provider[] {
  if (target.kind === 'local') return providers
  return providers.map((provider) => {
    const remote = target.probe.providers.find((item) => item.id === provider.id)
    const connected = remoteSubscriptionReady(remote)
    return {
      ...provider,
      installed: remote?.installed ?? false,
      connected,
      model: null,
      availableModels: [],
      plan: remote?.authentication?.exactPlan ?? null,
      usage: null,
      usageSource: 'unavailable',
      usageKind: 'unavailable',
      usageDetails: [],
      usageReason: remote?.installed
        ? 'The SSH probe does not report subscription usage. Exact per-run tokens appear after completed remote CLI runs when the CLI provides them.'
        : 'This CLI was not found on the verified SSH worker.',
      status: remote?.authentication?.reason ?? remote?.reason ?? 'Not found on the verified SSH worker.',
      canConnect: false,
      checkedAt: target.probe.checkedAt,
    }
  })
}

function targetKey(target: ExecutionTarget) {
  return target.kind === 'local'
    ? 'local'
    : `ssh:${target.connection.username}@${target.connection.hostname}:${target.connection.port}:${target.probe.project.canonicalPath ?? target.connection.projectPath}`
}

function providerFromStatus(status: CliProviderStatus, current: Provider): Provider {
  return {
    ...current,
    name: status.name,
    connected: status.routeKind === 'subscription' && status.connectionState === 'ready',
    authenticationState: status.authentication.state,
    accountLogin: status.authentication.accountLogin ?? null,
    installed: status.installed,
    version: status.version,
    usage: status.usage.usedPercent,
    status: status.authentication.reason,
    plan: status.usage.plan ?? status.authentication.exactPlan ?? null,
    model: status.usage.model,
    availableModels: status.availableModels ?? [],
    usageSource: status.usage.source,
    usageKind: status.usage.kind,
    usageDetails: status.usage.details,
    resetsIn: status.usage.resetAt,
    resetLabel: status.usage.resetLabel ?? null,
    resetWindow: status.usage.resetWindow ?? null,
    usageReason: status.usage.reason,
    usageStale: status.usage.stale === true,
    usageCheckedAt: status.usage.checkedAt ?? null,
    canConnect: status.canConnect,
    canUpdate: status.canUpdate,
    updateStrategy: status.updateStrategy,
    updateReason: status.updateReason,
    routeKind: status.routeKind,
    chatExecution: status.chatExecution,
    setupKind: status.setupKind,
    documentationUrl: status.documentationUrl,
    catalogReason: status.catalogReason,
    checkedAt: status.checkedAt,
  }
}

type RelayProject = ProjectInspection & {
  color: string
  verified: boolean
}

type ModelTelemetry = {
  provider: ChatProviderId
  model: string
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  runs: number
  lastRunAt: string
}

const MODEL_SIZE_OPTIONS: Array<{ tier: ModelSizeTier; label: string; description: string }> = [
  { tier: 'small', label: 'Small', description: 'Faster responses with lighter reasoning' },
  { tier: 'medium', label: 'Medium', description: 'Balanced reasoning for everyday tasks' },
  { tier: 'large', label: 'Large', description: 'Deeper reasoning for complex tasks' },
  { tier: 'xl', label: 'XL', description: 'Maximum reasoning for the hardest tasks' },
]

function isModelSizeTier(value: unknown): value is ModelSizeTier {
  return MODEL_SIZE_OPTIONS.some((option) => option.tier === value)
}

function sizeTierForEffort(effort: ReturnType<typeof effortForModelSize>): ModelSizeTier | null {
  return sizeForModelEffort(effort)
}

function modelSizeLabel(tier: ModelSizeTier) {
  return MODEL_SIZE_OPTIONS.find((option) => option.tier === tier)?.label ?? tier
}

function normalizeChatModelChoice(chat: Chat): Chat {
  let migratedSemanticSummary: string | null = null
  const messages = chat.messages.map((message) => {
    if (message.role !== 'agent') return message
    const extracted = extractEnsyncContinuation(message.content)
    if (extracted.semanticSummary !== null) migratedSemanticSummary = extracted.semanticSummary
    return extracted.visibleResponse === message.content
      ? message
      : { ...message, content: extracted.visibleResponse }
  })
  return {
    ...chat,
    agentWorkspaceKey: resolveConversationWorkspaceKey(chat),
    model: null,
    sizeTier: isModelSizeTier(chat.sizeTier) ? chat.sizeTier : null,
    messages,
    continuation: chat.continuation
      ? {
          ...chat.continuation,
          semanticSummary: chat.continuation.semanticSummary ?? migratedSemanticSummary,
        }
      : chat.continuation,
  }
}

function continuationGit(status: GitStatus | null) {
  return status ? {
    branch: status.branch,
    dirty: status.dirty,
    changedFiles: status.changedFiles,
    checkedAt: status.checkedAt,
  } : null
}

function withChatId(chatId: string) {
  return (current: ReadonlySet<string>) => {
    if (current.has(chatId)) return current
    return new Set(current).add(chatId)
  }
}

function withoutChatId(chatId: string) {
  return (current: ReadonlySet<string>) => {
    if (!current.has(chatId)) return current
    const next = new Set(current)
    next.delete(chatId)
    return next
  }
}

function runNeedsReconciliation(error: unknown) {
  const code = error instanceof EnsyncHostError || error instanceof RemoteSshClientError
    ? error.code
    : null
  return code !== null && [
    'run_timed_out',
    'ssh_timed_out',
    'invalid_cli_output',
    'empty_cli_response',
    // Droid ends its turn as soon as Ensync declines a permission request, so
    // committed work usually exists on the branch and needs reconciling.
    'provider_permission_declined',
    'cli_failed',
    'execution_stream_disconnected',
    'chat_job_stream_disconnected',
    'invalid_execution_stream',
    'invalid_chat_job_stream',
  ].includes(code)
}

function runWasInterrupted(error: unknown) {
  return error instanceof EnsyncHostError && error.code === 'execution_stream_disconnected'
}

const EMPTY_PROJECT: RelayProject = {
  id: '',
  name: 'Select project',
  path: '',
  host: 'local',
  context: {
    relayDirectory: false,
    files: [],
    featureFiles: [],
    truncated: false,
    error: null,
    instructionAdapters: [],
  },
  inspectedAt: '',
  color: PROJECT_COLORS[0],
  verified: false,
}

function verifiedProject(project: ProjectInspection): RelayProject {
  return { ...project, color: projectColor(project.path || project.id), verified: true }
}

function supportsChat(provider: Provider): provider is Provider & { id: ChatProviderId } {
  return provider.chatExecution === 'supported'
}

function automaticProvider(providers: Provider[], priorityOrder: readonly ProviderId[], preferredId?: ProviderId) {
  const ordered = orderedAutomaticProviders(providers, priorityOrder)
  return selectAutomaticProvider(providers, priorityOrder)
    ?? ordered.find((provider) => provider.id === preferredId)
    ?? ordered[0]
    ?? providers.find((provider) => provider.id === preferredId)
    ?? providers[0]
    ?? defaultProviders[0]
}

/**
 * Display resolution for a conversation. `activeRun` pins the name to the provider
 * that actually owns the running turn, so a mid-run usage refresh can no longer
 * rename it. Routing call sites pass no run: they must resolve the next turn.
 */
function providerForChat(
  providers: Provider[],
  chat: Chat | undefined,
  priorityOrder: readonly ProviderId[],
  activeRun?: PersistedInFlightRun,
) {
  if (!chat) return providers[0] ?? defaultProviders[0]
  const displayedId = conversationProviderId({ chat, activeRun, providers, priorityOrder })
  const displayed = displayedId ? providers.find((provider) => provider.id === displayedId) : undefined
  if (displayed) return displayed
  return chat.providerMode === 'fixed'
    ? providers.find((provider) => provider.id === chat.provider) ?? providers[0] ?? defaultProviders[0]
    : automaticProvider(providers, priorityOrder, chat.provider)
}

/** True only when an executing run actually determines the displayed provider. */
function runPinsDisplayedProvider(providers: Provider[], activeRun: PersistedInFlightRun | undefined) {
  return Boolean(activeRun) && providers.some((provider) => provider.id === activeRun?.provider)
}

function ProviderMark({ provider, small = false }: { provider: Provider; small?: boolean }) {
  return (
    <span
      className={`provider-mark ${small ? 'provider-mark--small' : ''}`}
      style={{ '--provider-color': provider.color } as React.CSSProperties}
      aria-hidden="true"
    >
      {provider.mark}
    </span>
  )
}

function CopyTextButton({ text, label = 'Copy', showLabel = true }: { text: string; label?: string; showLabel?: boolean }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus('error')
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('error')
    }
  }

  const statusLabel = status === 'copied' ? 'Copied' : status === 'error' ? 'Copy failed' : label
  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={status === 'idle' ? label : statusLabel}
        title={status === 'error' ? 'Clipboard access was unavailable. Try copying again.' : statusLabel}
      >
        {status === 'copied' ? <Check size={13} /> : status === 'error' ? <CircleHelp size={13} /> : <Copy size={13} />}
        {showLabel && <span>{status === 'idle' ? 'Copy' : statusLabel}</span>}
      </button>
      <span className="copy-announcement" role="status" aria-live="polite">{status === 'idle' ? '' : statusLabel}</span>
    </>
  )
}

function Toggle({ enabled, onChange, label, disabled = false }: { enabled: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button className={`toggle ${enabled ? 'toggle--on' : ''}`} onClick={onChange} role="switch" aria-checked={enabled} aria-label={label} disabled={disabled}>
      <span />
    </button>
  )
}

function useFloatingMenuPosition(open: boolean, anchorRef: { current: HTMLElement | null }) {
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    if (!anchor) return

    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect()
      const viewportPadding = 12
      const gap = 7
      const width = Math.min(360, window.innerWidth - viewportPadding * 2)
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        window.innerWidth - width - viewportPadding,
      )
      const spaceBelow = window.innerHeight - rect.bottom - viewportPadding - gap
      const spaceAbove = rect.top - viewportPadding - gap
      const placeAbove = spaceBelow < 260 && spaceAbove > spaceBelow
      const availableHeight = Math.max(160, Math.min(650, placeAbove ? spaceAbove : spaceBelow))
      setStyle({
        position: 'fixed',
        zIndex: 90,
        left,
        width,
        maxHeight: availableHeight,
        top: placeAbove ? 'auto' : rect.bottom + gap,
        bottom: placeAbove ? window.innerHeight - rect.top + gap : 'auto',
        visibility: 'visible',
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition)
    resizeObserver?.observe(anchor)
    const pane = anchor.closest('.relay-split-pane')
    if (pane) resizeObserver?.observe(pane)

    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      resizeObserver?.disconnect()
    }
  }, [anchorRef, open])

  return style
}

function App() {
  const nativeWorkspaceIdentity = getNativeWorkspaceIdentity()
  const nativeProjectLaunch = getInitialNativeProjectLaunch()
  const workspaceSnapshotKeys = useMemo(
    () => createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, nativeWorkspaceIdentity)),
    [nativeWorkspaceIdentity],
  )
  const splitLayoutStorageKey = workspaceStorageKey('ensync-split-layout-v1', nativeWorkspaceIdentity)
  const sidebarStorageKey = workspaceStorageKey('ensync-conversations-sidebar-v1', nativeWorkspaceIdentity)
  const { getSectionProps, setVisible, visibility } = useUIVisibility()
  const { completionIndicator } = useDisplayPreferences()
  const {
    settings: completionNotificationSettings,
    notifyCompletion,
    notifyAnswerNeeded,
  } = useCompletionNotifications()
  const [hydrated] = useState<StoredState | null>(readInitialStoredState)
  const workspaceRecoveryIds = hydrated?.workspaceRecoveryIds ?? []
  const recentProjectRecoveryIds = hydrated?.recentProjectRecoveryIds ?? []
  const conversationImportIds = hydrated?.conversationImportIds ?? []
  const archivedProjectRecoveryIds = hydrated?.archivedProjectRecoveryIds ?? []
  const [chats, setChats] = useState<Chat[]>(() => (hydrated?.chats ?? initialChats).map(normalizeChatModelChoice))
  const [tabs, setTabs] = useState<WorkspaceTab[]>(
    Array.isArray(hydrated?.tabs)
      ? hydrated.tabs
      : [
          { id: 'tab-new-conversation', chatId: 'new-conversation' },
        ],
  )
  const [activeTabId, setActiveTabId] = useState(hydrated?.activeTabId ?? 'tab-new-conversation')
  const [providers, setProviders] = useState<Provider[]>(defaultProviders)
  const [hostOnline, setHostOnline] = useState(false)
  const [hostError, setHostError] = useState<string | null>(null)
  const [placement, setPlacement] = useState<NewTabPlacement>(hydrated?.placement ?? 'adjacent')
  const [conversationLayout, setConversationLayout] = useState<ConversationLayoutMode>(hydrated?.conversationLayout === 'tabs' ? 'tabs' : 'split')
  const [autoFallback, setAutoFallback] = useState(hydrated?.autoFallback ?? true)
  const [autoContextSkill, setAutoContextSkill] = useState(hydrated?.autoContextSkill ?? false)
  const [fallbackProviderOrder, setFallbackProviderOrder] = useState<ProviderId[]>(() =>
    resolveFallbackProviderOrder(window.localStorage, hydrated?.fallbackProviderOrder ?? DEFAULT_FALLBACK_PROVIDER_ORDER),
  )
  // The ranking is one device-wide choice, so it is written the moment it
  // changes rather than at the next workspace snapshot: another window, and the
  // Host's connector API, must not keep routing by the previous order.
  const updateFallbackProviderOrder = useCallback((next: ProviderId[]) => {
    setFallbackProviderOrder(writeStoredFallbackProviderOrder(window.localStorage, next))
  }, [])
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>(hydrated?.drafts ?? {})
  const [draftAttachments, setDraftAttachments] = useState<Record<string, FileAttachment[]>>(() =>
    Object.fromEntries(Object.entries(hydrated?.draftAttachments ?? {}).map(([chatId, attachments]) => [
      chatId,
      normalizeFileAttachments(attachments),
    ])),
  )
  const [providerMenuChatId, setProviderMenuChatId] = useState<string | null>(null)
  const [modelMenuChatId, setModelMenuChatId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [viewedFilePath, setViewedFilePath] = useState<string | null>(null)
  const [accountSyncStatus, setAccountSyncStatus] = useState<AccountSyncStatus>(EMPTY_ACCOUNT_SYNC_STATUS)
  const [accountSyncPhase, setAccountSyncPhase] = useState<'checking' | 'idle' | 'syncing' | 'error'>('checking')
  const [accountSyncMessage, setAccountSyncMessage] = useState<string | null>(null)
  const [agentUpdatePreferences, setAgentUpdatePreferences] = useState<AgentUpdatePreferences>(() =>
    readAgentUpdatePreferences(window.localStorage),
  )
  const [agentUpdateNotice, setAgentUpdateNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const [supportOpen, setSupportOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [gitWorkflowMode, setGitWorkflowMode] = useState<'clone' | 'manage' | null>(null)
  const [projects, setProjects] = useState<RelayProject[]>(() =>
    (hydrated?.projects ?? []).map((project) => ({
      ...project,
      color: projectColor(project.path || project.id),
      verified: false,
    })),
  )
  const [nativeRecentProjects, setNativeRecentProjects] = useState<NativeRecentProject[]>(getNativeRecentProjects)
  const [activeProjectId, setActiveProjectId] = useState(hydrated?.activeProjectId ?? '')
  const [projectError, setProjectError] = useState<string | null>(null)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [remoteInitialRuntime, setRemoteInitialRuntime] = useState<'local' | 'remote' | 'virtualbox'>('local')
  const [usageOpen, setUsageOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const chatRunRegistryRef = useRef(createChatRunRegistry())
  const chatRunCancellationRef = useRef(createChatRunCancellationRegistry())
  const providerRefreshInFlightRef = useRef<Promise<boolean> | null>(null)
  const recoveringChatIdsRef = useRef(new Set<string>())
  const rediscoveringHostJobsRef = useRef(false)
  const rediscoveredHostJobsRef = useRef(false)
  const steeringChatIdsRef = useRef(new Set<string>())
  const occupiedOwnerMissingExactJobRef = useRef(new Set<string>())
  const occupiedOwnerPollCountRef = useRef(new Map<string, number>())
  const occupiedJobProbeCoordinatorRef = useRef(createOccupiedJobProbeCoordinator())
  const occupiedOwnerAdoptionRef = useRef(new Set<string>())
  const recoverDetachedRunRef = useRef<(chatId: string, run: PersistedInFlightRun) => void>(() => {})
  const completedNativeRunsRef = useRef(new Map<string, CompletedNativeRunBinding>())
  const handoffActionsInvokedRef = useRef(new Set<string>())
  const transferringChatIdsRef = useRef(new Set<string>())
  // A stop-and-send arms exactly one cancellation to advance the queue. It is
  // consumed by that run's teardown so a later unrelated stop never inherits it.
  const stopAndSendChatIdsRef = useRef(new Set<string>())
  const activeTurnIdsRef = useRef<Record<string, string>>({})
  const drainPromptQueueRef = useRef<(chatId: string) => void>(() => {})
  const [sendingChatIds, setSendingChatIds] = useState<ReadonlySet<string>>(() => new Set())
  const [pushingQueuedChatIds, setPushingQueuedChatIds] = useState<ReadonlySet<string>>(() => new Set())
  // Chats whose last turn failed with a Host proof that it performed no work.
  // Deliberately not persisted: after a restart Ensync no longer holds that
  // proof in hand, and it will not invite a re-run it cannot vouch for.
  const [verifiedRetryableChatIds, setVerifiedRetryableChatIds] = useState<ReadonlySet<string>>(() => new Set())
  const [readCompletionByChat, setReadCompletionByChat] = useState<Record<string, string>>(
    hydrated?.readCompletionByChat ?? {},
  )
  const [chatSessions, setChatSessions] = useState<Record<string, { provider: ChatProviderId; sessionId: string; targetKey?: string; syncedMessageCount?: number }>>(hydrated?.chatSessions ?? {})
  const [chatErrors, setChatErrors] = useState<Record<string, string | null>>(hydrated?.chatErrors ?? {})
  const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string | null>>({})
  const [chatExecutionEvents, setChatExecutionEvents] = useState<Record<string, ChatExecutionEvent[]>>(hydrated?.chatExecutionEvents ?? {})
  const [executionPanelOpenByChat, setExecutionPanelOpenByChat] = useState<Record<string, boolean>>(() =>
    normalizeExecutionPanelOpenByChat(hydrated?.executionPanelOpenByChat),
  )
  const [modelTelemetry, setModelTelemetry] = useState<ModelTelemetry[]>(hydrated?.modelTelemetry ?? [])
  const [splitLayout, setSplitLayout] = useState<SplitWorkspaceLayout | undefined>(hydrated?.splitLayout)
  const [conversationSidebarWidth, setConversationSidebarWidth] = useState(() =>
    hydrated?.conversationSidebarWidth ?? readResizableSidebarPreferences(sidebarStorageKey).width,
  )
  const [inFlightRuns, setInFlightRuns] = useState<Record<string, PersistedInFlightRun>>(
    hydrated?.inFlightRuns ?? {},
  )
  const [hostJobRecoveryRetry, setHostJobRecoveryRetry] = useState(0)
  const [occupiedJobProbeRetry, setOccupiedJobProbeRetry] = useState(0)
  const [promptQueues, setPromptQueues] = useState<PromptQueues>(() => normalizePromptQueues(hydrated?.promptQueues))
  const [occupiedRuns, setOccupiedRuns] = useState<OccupiedRuns>(() => normalizeOccupiedRuns(hydrated?.occupiedRuns))
  // Shell reachability is live native authority, never retained workspace data.
  const [occupiedShellReachability, setOccupiedShellReachability] = useState<Record<string, string>>({})
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget>({ kind: 'local' })
  const chatsRef = useRef(chats)
  const tabsRef = useRef(tabs)
  const activeTabIdRef = useRef(activeTabId)
  const draftsRef = useRef(drafts)
  const draftAttachmentsRef = useRef(draftAttachments)
  const providersRef = useRef(providers)
  const projectsRef = useRef(projects)
  const chatSessionsRef = useRef(chatSessions)
  const chatErrorsRef = useRef(chatErrors)
  const chatExecutionEventsRef = useRef(chatExecutionEvents)
  const inFlightRunsRef = useRef(inFlightRuns)
  const promptQueuesRef = useRef(promptQueues)
  const occupiedRunsRef = useRef(occupiedRuns)
  const occupiedShellReachabilityRef = useRef(occupiedShellReachability)
  const executionTargetRef = useRef(executionTarget)
  const accountSyncInFlightRef = useRef<Promise<void> | null>(null)
  const accountSyncFingerprintRef = useRef<string | null>(null)
  const automaticUpdateAttemptRef = useRef(false)
  const focusProjectRequestRef = useRef<(project: RelayProject, allowNativeRoute?: boolean) => Promise<void>>(async () => {})
  const openChatRef = useRef<(chatId: string) => void>(() => {})
  const pushQueuedNowRef = useRef<(chatId: string) => Promise<void>>(async () => {})
  const stopAndSendNowRef = useRef<(chatId: string) => void>(() => {})
  chatsRef.current = chats
  tabsRef.current = tabs
  activeTabIdRef.current = activeTabId
  draftsRef.current = drafts
  draftAttachmentsRef.current = draftAttachments
  providersRef.current = providers
  projectsRef.current = projects
  chatSessionsRef.current = chatSessions
  chatErrorsRef.current = chatErrors
  chatExecutionEventsRef.current = chatExecutionEvents
  inFlightRunsRef.current = inFlightRuns
  promptQueuesRef.current = promptQueues
  occupiedRunsRef.current = occupiedRuns
  occupiedShellReachabilityRef.current = occupiedShellReachability
  executionTargetRef.current = executionTarget

  // A provider that stops to ask something holds its run until the person
  // answers, and it can ask in a conversation nobody is looking at — so the
  // alert watches every conversation, not the visible one. It marks a question
  // arriving: one ring per question however often the panel re-renders it, and
  // silence for a question that was already open when this window loaded.
  const announcedQuestionsRef = useRef<{ hydrated: boolean, ids: Set<string> }>({ hydrated: false, ids: new Set() })
  useEffect(() => {
    const { alerts, announced } = questionsNeedingAlert(
      pendingQuestionsByChat(chatExecutionEvents),
      announcedQuestionsRef.current.ids,
    )
    const alreadyLoaded = announcedQuestionsRef.current.hydrated
    announcedQuestionsRef.current = { hydrated: true, ids: announced }
    if (alreadyLoaded && alerts.length > 0) void notifyAnswerNeeded()
  }, [chatExecutionEvents, notifyAnswerNeeded])

  const workspaceSnapshot: StoredState = {
    chats,
    tabs,
    activeTabId,
    chatSessions,
    modelTelemetry,
    projects,
    activeProjectId,
    placement,
    conversationLayout,
    autoFallback,
    autoContextSkill,
    readCompletionByChat,
    executionPanelOpenByChat,
    drafts,
    draftAttachments,
    chatErrors,
    chatExecutionEvents,
    splitLayout,
    uiVisibility: visibility,
    conversationSidebarWidth,
    inFlightRuns,
    promptQueues,
    occupiedRuns,
    workspaceRecoveryIds,
    recentProjectRecoveryIds,
    conversationImportIds,
    archivedProjectRecoveryIds,
  }
  const workspaceSnapshotRef = useRef(workspaceSnapshot)
  workspaceSnapshotRef.current = workspaceSnapshot

  const commitWorkspace = useCallback((overrides?: Partial<StoredState>) => {
    try {
      commitWorkspaceSnapshot(
        window.localStorage,
        compactWorkspaceSnapshot({ ...workspaceSnapshotRef.current, ...overrides }),
        { keys: workspaceSnapshotKeys },
      )
      return true
    } catch (error) {
      console.error('[ensync-workspace-persistence]', error)
      return false
    }
  }, [workspaceSnapshotKeys])

  const saveAgentUpdatePreferences = useCallback((update: AgentUpdatePreferences | ((current: AgentUpdatePreferences) => AgentUpdatePreferences)) => {
    setAgentUpdatePreferences((current) => writeAgentUpdatePreferences(
      window.localStorage,
      typeof update === 'function' ? update(current) : update,
    ))
  }, [])

  const setAgentUpdateMode = useCallback((mode: AgentUpdateMode) => {
    saveAgentUpdatePreferences((current) => ({ ...current, mode }))
    setAgentUpdateNotice(null)
  }, [saveAgentUpdatePreferences])

  const acknowledgeAgentUpdate = useCallback(() => {
    saveAgentUpdatePreferences((current) => acknowledgeAgentUpdateReminder(current))
  }, [saveAgentUpdatePreferences])

  const recordAgentMaintenance = useCallback(() => {
    saveAgentUpdatePreferences((current) => recordAgentUpdateMaintenance(current))
  }, [saveAgentUpdatePreferences])

  const synchronizeAccountWorkspace = useCallback(() => {
    if (accountSyncInFlightRef.current) return accountSyncInFlightRef.current
    const run = (async () => {
      setAccountSyncPhase('syncing')
      setAccountSyncMessage(null)
      try {
        const pulled = await accountSyncHost.pull()
        let merged = mergeAccountWorkspace(workspaceSnapshotRef.current, pulled.state)
        let portable = prepareAccountWorkspace(merged.state)
        const remotePortable = pulled.state ? prepareAccountWorkspace(pulled.state as Record<string, unknown>) : null
        let revision = pulled.revision
        let updatedAt = pulled.updatedAt

        if (!remotePortable || JSON.stringify(remotePortable) !== JSON.stringify(portable)) {
          const pushed = await accountSyncHost.push(portable, revision)
          if (pushed.status === 'conflict') {
            merged = mergeAccountWorkspace(merged.state, pushed.remoteState)
            portable = prepareAccountWorkspace(merged.state)
            const retry = await accountSyncHost.push(portable, pushed.revision)
            if (retry.status === 'conflict') {
              throw new Error('Synchronized conversations changed again. Try Sync now once more.')
            }
            revision = retry.revision
            updatedAt = retry.updatedAt
          } else {
            revision = pushed.revision
            updatedAt = pushed.updatedAt
          }
        }

        const nextState = merged.state as StoredState
        setChats((nextState.chats ?? []).map(normalizeChatModelChoice))
        const nextProjects = (nextState.projects ?? []).map((project) => ({
          ...project,
          color: projectColor(project.path || project.id),
          verified: project.verified === true,
        }))
        setProjects(nextProjects)
        commitWorkspace({ chats: nextState.chats ?? [], projects: nextProjects })
        accountSyncFingerprintRef.current = JSON.stringify(portable)
        const syncedAt = new Date().toISOString()
        setAccountSyncStatus((current) => ({
          ...current,
          authenticated: true,
          remoteRevision: revision,
          lastSyncedAt: syncedAt,
        }))
        setAccountSyncPhase('idle')
        setAccountSyncMessage(
          merged.importedChats > 0
            ? `${merged.importedChats} ${merged.importedChats === 1 ? 'conversation' : 'conversations'} added from your account.`
            : updatedAt
              ? 'Conversations are up to date.'
              : 'Your conversations are now protected by account sync.',
        )
      } catch (error) {
        setAccountSyncPhase('error')
        setAccountSyncMessage(error instanceof Error ? error.message : 'Conversations could not be synchronized.')
        throw error
      }
    })().finally(() => {
      accountSyncInFlightRef.current = null
    })
    accountSyncInFlightRef.current = run
    return run
  }, [commitWorkspace])

  const authenticateAccountSync = useCallback(async (mode: 'register' | 'login', username: string, password: string) => {
    setAccountSyncPhase('syncing')
    setAccountSyncMessage(null)
    try {
      const status = mode === 'register'
        ? await accountSyncHost.register(username, password)
        : await accountSyncHost.login(username, password)
      setAccountSyncStatus(status)
      await synchronizeAccountWorkspace()
    } catch (error) {
      setAccountSyncPhase('error')
      setAccountSyncMessage(error instanceof Error ? error.message : 'Account login failed.')
      throw error
    }
  }, [synchronizeAccountWorkspace])

  const logoutAccountSync = useCallback(async () => {
    setAccountSyncPhase('syncing')
    setAccountSyncMessage(null)
    try {
      const status = await accountSyncHost.logout()
      setAccountSyncStatus(status)
      accountSyncFingerprintRef.current = null
      setAccountSyncPhase('idle')
    } catch (error) {
      setAccountSyncPhase('error')
      setAccountSyncMessage(error instanceof Error ? error.message : 'Account logout failed.')
    }
  }, [])

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? EMPTY_PROJECT
  const recentProjectOptions = useMemo(() => {
    const options: RelayProject[] = []
    const paths = new Set<string>()
    const append = (project: RelayProject) => {
      if (!project.path) return
      const normalized = project.path.replaceAll('\\', '/').replace(/\/+$/, '')
      const key = /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
        ? normalized.toLowerCase()
        : normalized
      if (paths.has(key)) return
      paths.add(key)
      options.push(project)
    }
    append(activeProject)
    for (const project of nativeRecentProjects) {
      append({
        id: `recent:${project.path}`,
        name: project.name,
        path: project.path,
        host: 'local',
        context: EMPTY_PROJECT.context,
        inspectedAt: '',
        color: projectColor(project.path),
        verified: false,
      })
    }
    for (const project of projects) append(project)
    return options
  }, [activeProject, nativeRecentProjects, projects])
  const projectChats = chats.filter((chat) => chat.projectId === activeProject.id)
  const projectChatIds = new Set(projectChats.map((chat) => chat.id))
  const projectTabs = tabs.filter((tab) => projectChatIds.has(tab.chatId))
  const activeTab = projectTabs.find((tab) => tab.id === activeTabId) ?? projectTabs[0]
  const activeChat = projectChats.find((chat) => chat.id === activeTab?.chatId)
  const completedTabIds = unreadCompletionTabIds({
    tabs: projectTabs,
    chats: projectChats,
    sendingChatIds,
    readCompletionByChat,
  })
  const executionProviders = useMemo(() => providersForTarget(providers, executionTarget), [providers, executionTarget])
  const installedAgentProviders = useMemo(
    () => providers.filter((provider) => provider.installed === true),
    [providers],
  )
  const updateableAgentProviders = useMemo(
    () => installedAgentProviders.filter((provider) => provider.canUpdate === true),
    [installedAgentProviders],
  )
  const agentUpdateReminderDue = hostOnline
    && agentUpdatePreferences.mode === 'remind'
    && installedAgentProviders.length > 0
    && agentUpdateDue(agentUpdatePreferences)
  const displayProjectChats = projectChats.map((chat) => ({
    ...chat,
    provider: providerForChat(executionProviders, chat, fallbackProviderOrder).id,
  }))
  const activeProvider = providerForChat(executionProviders, activeChat, fallbackProviderOrder)
  const fallbackProviders = orderedAutomaticProviders(executionProviders, fallbackProviderOrder)
    .filter((provider) => provider.connected && supportsChat(provider) && (provider.usage === null || provider.usage < 100))
  // Support repair runs only the structured Codex or Claude runner (host/support-repair.mjs).
  const repairCapableProviders = executionProviders.filter((provider) => provider.id === 'codex' || provider.id === 'claude')
  const supportProvider = automaticProvider(repairCapableProviders, fallbackProviderOrder, activeProvider.id)
  const supportRepairAvailable = executionTarget.kind === 'local'
    && activeProject.verified
    && supportProvider.connected
    && supportsChat(supportProvider)
    && (supportProvider.usage === null || supportProvider.usage < 100)
  const currentTargetKey = targetKey(executionTarget)
  const accountWorkspaceDocument = useMemo(
    () => prepareAccountWorkspace({ chats, projects }),
    [chats, projects],
  )
  const owningConversationTargets = useMemo<Record<string, ReferencedOwningConversation>>(() => {
    if (!isNativeWorkspaceIdentity(nativeWorkspaceIdentity)) return {}
    const retainedWorkspaces = getRetainedNativeWorkspaces()
    return Object.fromEntries(chats.flatMap((chat) => {
      const target = findReferencedOwningConversation(window.localStorage, {
        currentWorkspace: nativeWorkspaceIdentity,
        retainedWorkspaces,
        currentState: { projects, chats },
        chat,
      })
      return target ? [[chat.id, target]] : []
    }))
  }, [chats, nativeWorkspaceIdentity, projects])
  const accountWorkspaceFingerprint = useMemo(
    () => JSON.stringify(accountWorkspaceDocument),
    [accountWorkspaceDocument],
  )

  const markChatRead = useCallback((chatId: string) => {
    const chat = chatsRef.current.find((item) => item.id === chatId)
    if (!chat) return
    setReadCompletionByChat((current) => markChatCompletionRead(current, chat))
  }, [])

  const activateTab = useCallback((tabId: string) => {
    activeTabIdRef.current = tabId
    setActiveTabId(tabId)
    const chatId = tabsRef.current.find((tab) => tab.id === tabId)?.chatId
    if (chatId) markChatRead(chatId)
  }, [markChatRead])

  const appendChatExecutionEvent = useCallback((chatId: string, event: ChatExecutionEvent) => {
    const events = [...(chatExecutionEventsRef.current[chatId] ?? []), event]
    if (typeof event.sequence === 'number'
      && events.slice(0, -1).some((candidate) => candidate.sequence === event.sequence)) return
    let retainedCharacters = 0
    const retained: ChatExecutionEvent[] = []
    for (let index = events.length - 1; index >= 0 && retained.length < 500; index -= 1) {
      const candidate = events[index]
      const size = candidate.type === 'output' || candidate.type === 'note'
        ? candidate.text.length
        : candidate.type === 'started'
          ? candidate.command.length + candidate.cwd.length
          : candidate.type === 'question'
            ? candidate.questions.reduce((total, question) => total + question.question.length, 0)
            : candidate.type === 'question_resolved'
              ? candidate.answers.reduce((total, answer) => total + answer.answer.length, 0)
              : candidate.message.length
      if (retained.length > 0 && retainedCharacters + size > 1024 * 1024) break
      retained.unshift(candidate)
      retainedCharacters += size
    }
    const next = { ...chatExecutionEventsRef.current, [chatId]: retained }
    chatExecutionEventsRef.current = next
    setChatExecutionEvents(next)
    if (event.type === 'notice' && event.code === 'project_workspace_ready') {
      const nextChats = chatsRef.current.map((chat) => chat.id === chatId ? {
        ...chat,
        subtitle: 'Working in protected branch',
        workspace: event.workspace
          ? { path: event.workspace.path, branch: event.workspace.branch }
          : chat.workspace,
      } : chat)
      chatsRef.current = nextChats
      setChats(nextChats)
    }
  }, [])

  const updateInFlightRun = useCallback((chatId: string, update: (run: PersistedInFlightRun | undefined) => PersistedInFlightRun | undefined) => {
    const updated = update(inFlightRunsRef.current[chatId])
    const next = { ...inFlightRunsRef.current }
    if (updated) next[chatId] = updated
    else delete next[chatId]
    inFlightRunsRef.current = next
    setInFlightRuns(next)
    return next
  }, [])

  const updateOccupiedRuns = useCallback((next: OccupiedRuns) => {
    occupiedRunsRef.current = next
    setOccupiedRuns(next)
    return next
  }, [])

  const updateOccupiedShellReachability = useCallback((chatId: string, ownerJobId: string, reachable: boolean) => {
    const current = occupiedShellReachabilityRef.current
    const next = { ...current }
    if (reachable) next[chatId] = ownerJobId
    else delete next[chatId]
    occupiedShellReachabilityRef.current = next
    setOccupiedShellReachability(next)
  }, [])

  const rememberCompletedNativeRun = useCallback((chatId: string, run: PersistedInFlightRun | undefined) => {
    const completed = completedNativeRunBinding(
      isNativeWorkspaceIdentity(nativeWorkspaceIdentity) ? nativeWorkspaceIdentity.id : null,
      chatId,
      run,
    )
    if (!completed) return
    completedNativeRunsRef.current.delete(completed.jobId)
    completedNativeRunsRef.current.set(completed.jobId, completed)
    while (completedNativeRunsRef.current.size > 128) {
      const oldest = completedNativeRunsRef.current.keys().next().value
      if (typeof oldest !== 'string') break
      completedNativeRunsRef.current.delete(oldest)
    }
  }, [nativeWorkspaceIdentity])

  const updateChatError = useCallback((chatId: string, error: string | null) => {
    const next = { ...chatErrorsRef.current, [chatId]: error }
    chatErrorsRef.current = next
    setChatErrors(next)
    return next
  }, [])

  /**
   * Delivers an answer to the provider run this conversation is blocked on.
   * The run keeps its own event stream, so the resolved question arrives back
   * as a Host event rather than being assumed here.
   */
  const handleAnswerQuestion = useCallback(async (
    chatId: string,
    answer: ProviderQuestionAnswerPayload | { questionId: string; cancelled: true },
  ) => {
    const activeRun = inFlightRunsRef.current[chatId]
    if (!activeRun?.jobId || activeRun.executionTarget !== 'local') {
      updateChatError(chatId, 'This conversation has no live local run waiting on an answer, so it was not delivered.')
      return
    }
    updateChatError(chatId, null)
    await ensyncHost.answerChatQuestion(activeRun.jobId, answer)
  }, [updateChatError])

  const toggleConversationSidebar = useCallback(() => {
    const mobileLayout = window.matchMedia('(max-width: 780px)').matches
    if (mobileLayout) {
      const nextOpen = !mobileNavOpen
      setVisible('conversationSidebar', nextOpen)
      setMobileNavOpen(nextOpen)
      return
    }

    const nextVisible = !visibility.conversationSidebar
    setVisible('conversationSidebar', nextVisible)
    if (!nextVisible) setMobileNavOpen(false)
  }, [mobileNavOpen, setVisible, visibility.conversationSidebar])

  const refreshProviders = useCallback((force = false) => {
    if (!force && providerRefreshInFlightRef.current) return providerRefreshInFlightRef.current

    const refresh = (async () => {
      try {
        const response = await ensyncHost.providers(force)
        // The Host ranks providers by real availability, so adopt its order
        // instead of keeping the pre-probe fallback order. A provider the Host
        // did not report keeps its relative position at the end of the list.
        const hostOrder = new Map(response.providers.map((item, index) => [item.id, index]))
        const nextProviders = providersRef.current
          .map((provider) => {
            const status = response.providers.find((item) => item.id === provider.id)
            return status ? providerFromStatus(status, provider) : provider
          })
          .sort((left, right) =>
            (hostOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
              - (hostOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
        providersRef.current = nextProviders
        setProviders(nextProviders)
        const firstRunnable = response.providers.find((status) =>
          status.chatExecution === 'supported' && status.connectionState === 'ready')
        if (firstRunnable && executionTarget.kind === 'local') {
          setChats((current) => current.map((chat) => {
            if (chat.messages.length > 0 || chat.subtitle !== 'Not started') return chat
            const currentStatus = response.providers.find((status) => status.id === chat.provider)
            return currentStatus?.chatExecution === 'supported' && currentStatus.connectionState === 'ready'
              ? chat
              : { ...chat, provider: firstRunnable.id as ProviderId }
          }))
        }
        setHostOnline(true)
        setHostError(null)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Ensync Host is unavailable.'
        setHostOnline(false)
        setHostError(message)
        const unavailableProviders = defaultProviders.map((provider) => ({
          ...provider,
          status: `Ensync Host unavailable: ${message}`,
          usageReason: 'Ensync is reconnecting to the local Host. Verified CLI values will return automatically.',
        }))
        providersRef.current = unavailableProviders
        setProviders(unavailableProviders)
        return false
      }
    })()

    if (!force) {
      providerRefreshInFlightRef.current = refresh
      void refresh.finally(() => {
        if (providerRefreshInFlightRef.current === refresh) providerRefreshInFlightRef.current = null
      })
    }
    return refresh
  }, [executionTarget.kind])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof window.setTimeout> | null = null
    let consecutiveFailures = 0

    const schedule = (delay: number) => {
      if (timer !== null) window.clearTimeout(timer)
      if (!stopped) timer = window.setTimeout(() => void poll(), delay)
    }
    const poll = async () => {
      if (stopped) return
      if (document.visibilityState !== 'visible') {
        schedule(nextProviderRefreshDelay({ visible: false, online: false, consecutiveFailures }))
        return
      }

      const online = await refreshProviders(false)
      if (stopped) return
      consecutiveFailures = online ? 0 : consecutiveFailures + 1
      schedule(nextProviderRefreshDelay({
        visible: true,
        online,
        consecutiveFailures,
      }))
    }
    const wake = () => {
      if (document.visibilityState === 'visible') void poll()
      else schedule(nextProviderRefreshDelay({ visible: false, online: false, consecutiveFailures }))
    }

    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    void poll()

    return () => {
      stopped = true
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
    }
  }, [refreshProviders])

  useEffect(() => subscribeNativeRecentProjects(setNativeRecentProjects), [])

  useEffect(() => {
    const synchronizePreferences = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage) {
        setAgentUpdatePreferences(readAgentUpdatePreferences(window.localStorage))
      }
    }
    window.addEventListener('storage', synchronizePreferences)
    return () => window.removeEventListener('storage', synchronizePreferences)
  }, [])

  useEffect(() => {
    if (agentUpdatePreferences.mode !== 'automatic'
      || !hostOnline
      || installedAgentProviders.length === 0
      || Object.keys(inFlightRuns).length > 0
      || !agentUpdateDue(agentUpdatePreferences)
      || automaticUpdateAttemptRef.current) return

    let cancelled = false
    automaticUpdateAttemptRef.current = true
    const providerManaged = installedAgentProviders.filter((provider) => provider.updateStrategy === 'provider_automatic')
    const guideOnly = installedAgentProviders.filter((provider) => provider.updateStrategy === 'official_guide')
    void Promise.allSettled(updateableAgentProviders.map((provider) =>
      ensyncHost.updateProvider(provider.id, true, 'automatic'),
    )).then((results) => {
      if (cancelled) return
      const completed = results.flatMap((result, index) =>
        result.status === 'fulfilled' && (result.value.started || result.value.deduplicated)
          ? [updateableAgentProviders[index].name]
          : [],
      )
      const failed = results.flatMap((result, index) =>
        result.status === 'fulfilled' && (result.value.started || result.value.deduplicated)
          ? []
          : [updateableAgentProviders[index].name],
      )
      if (completed.length === updateableAgentProviders.length) {
        recordAgentMaintenance()
        const details = [
          completed.length > 0 ? `Update terminals opened for ${completed.join(', ')}.` : null,
          providerManaged.length > 0 ? `${providerManaged.map((provider) => provider.name).join(', ')} use their own automatic updater.` : null,
          guideOnly.length > 0 ? `${guideOnly.map((provider) => provider.name).join(', ')} still need their official update guide because maintenance depends on the installation method or operating system.` : null,
        ].filter((detail): detail is string => detail !== null)
        setAgentUpdateNotice({
          tone: guideOnly.length > 0 ? 'error' : 'success',
          message: `${details.join(' ')} Provider updaters remain authoritative for completion.`,
        })
      } else if (completed.length > 0) {
        setAgentUpdateNotice({
          tone: 'error',
          message: `Update opened for ${completed.join(' and ')}, but ${failed.join(' and ')} could not start. Ensync will retry while the policy remains due.`,
        })
      } else {
        setAgentUpdateNotice({
          tone: 'error',
          message: 'Automatic agent updates could not start. Ensync will retry while the Host is online and idle.',
        })
      }
    }).finally(() => {
      automaticUpdateAttemptRef.current = false
    })
    return () => { cancelled = true }
  }, [agentUpdatePreferences, hostOnline, inFlightRuns, installedAgentProviders, recordAgentMaintenance, updateableAgentProviders])

  useEffect(() => {
    let cancelled = false
    void accountSyncHost.status().then((status) => {
      if (cancelled) return
      setAccountSyncStatus(status)
      setAccountSyncPhase('idle')
      if (status.authenticated) void synchronizeAccountWorkspace().catch(() => {})
    }).catch((error: unknown) => {
      if (cancelled) return
      setAccountSyncPhase('error')
      setAccountSyncMessage(error instanceof Error ? error.message : 'Account sync status is unavailable.')
    })
    return () => { cancelled = true }
  }, [synchronizeAccountWorkspace])

  useEffect(() => {
    if (!accountSyncStatus.authenticated
      || accountWorkspaceFingerprint === accountSyncFingerprintRef.current) return
    const timer = window.setTimeout(() => {
      void synchronizeAccountWorkspace().catch(() => {})
    }, 1_200)
    return () => window.clearTimeout(timer)
  }, [accountSyncStatus.authenticated, accountWorkspaceFingerprint, synchronizeAccountWorkspace])

  useEffect(() => {
    if (!accountSyncStatus.authenticated) return
    const poll = () => {
      if (document.visibilityState === 'visible') void synchronizeAccountWorkspace().catch(() => {})
    }
    const timer = window.setInterval(poll, 30_000)
    window.addEventListener('focus', poll)
    window.addEventListener('online', poll)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', poll)
      window.removeEventListener('online', poll)
    }
  }, [accountSyncStatus.authenticated, synchronizeAccountWorkspace])

  useLayoutEffect(() => {
    commitWorkspace()
  }, [activeProjectId, activeTabId, autoContextSkill, autoFallback, chatErrors, chatExecutionEvents, chatSessions, chats, commitWorkspace, conversationLayout, conversationSidebarWidth, draftAttachments, drafts, executionPanelOpenByChat, inFlightRuns, modelTelemetry, occupiedRuns, placement, projects, promptQueues, readCompletionByChat, splitLayout, tabs, visibility])

  useEffect(() => {
    const flush = () => commitWorkspace()
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', flushWhenHidden)
    }
  }, [commitWorkspace])

  useEffect(() => {
    let cancelled = false
    const remembered = nativeProjectLaunch
      ? { id: nativeProjectLaunch.projectId, path: nativeProjectLaunch.projectPath }
      : (hydrated?.projects ?? []).find((project) => project.id === hydrated?.activeProjectId)
    const hadRememberedProjects = Boolean(hydrated?.projects?.length)
    const hadRememberedTabs = Array.isArray(hydrated?.tabs)

    const restoreProject = async () => {
      try {
        const response = remembered?.path
          ? await ensyncHost.inspectProject(remembered.path)
          : await ensyncHost.currentProject()
        if (cancelled) return
        const project = verifiedProject(response.project)
        setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)])
        setActiveProjectId(project.id)
        void rememberNativeRecentProject(project).catch((error) => console.error('[ensync-recent-projects]', error))
        setProjectError(null)

        const stamp = Date.now()
        setChats((current) => {
          const migrated = hadRememberedProjects
            ? current
            : current.map((chat) => ['ensync', 'relay'].includes(chat.projectId) ? { ...chat, projectId: project.id } : chat)
          const existingProjectChats = migrated.filter((chat) => chat.projectId === project.id)
          if (existingProjectChats.length > 0) {
            const existingIds = new Set(existingProjectChats.map((chat) => chat.id))
            setTabs((currentTabs) => {
              const selected = currentTabs.find((tab) => tab.id === activeTabId && existingIds.has(tab.chatId))
                ?? currentTabs.find((tab) => existingIds.has(tab.chatId))
              if (selected) {
                activateTab(selected.id)
                return currentTabs
              }
              if (hadRememberedTabs) return currentTabs
              const tab = { id: `tab-${stamp}`, chatId: existingProjectChats[0].id }
              activateTab(tab.id)
              return [...currentTabs, tab]
            })
            return migrated
          }
          const chat: Chat = {
            id: `chat-${stamp}`,
            projectId: project.id,
            title: 'New conversation',
            subtitle: 'Not started',
            group: 'Today',
            provider: providers.find((provider) => provider.connected && supportsChat(provider))?.id ?? 'codex',
            providerMode: 'auto',
            model: null,
            sizeTier: null,
            messages: [],
          }
          setTabs((currentTabs) => [...currentTabs, { id: `tab-${stamp}`, chatId: chat.id }])
          activateTab(`tab-${stamp}`)
          return [chat, ...migrated]
        })
      } catch (error) {
        if (cancelled) return
        setProjectError(error instanceof Error ? error.message : 'Ensync Host could not inspect the project folder.')
      }
    }

    void restoreProject()
    return () => { cancelled = true }
    // Restore the initial persisted project exactly once; later provider/project changes are handled by their own flows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(true)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
        event.preventDefault()
        createChat()
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'w') {
        const currentTabId = activeTabIdRef.current
        if (currentTabId) {
          event.preventDefault()
          closeTab(currentTabId)
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        setCommandOpen(false)
        setSettingsOpen(true)
      }
      if (event.key === 'Escape') {
        setProviderMenuChatId(null)
        setCommandOpen(false)
        setWizardOpen(false)
        setSettingsOpen(false)
        setContextOpen(false)
        setProjectOpen(false)
        setRemoteOpen(false)
        setUsageOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const groupedChats = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    const filtered = normalized ? projectChats.filter((chat) => chat.title.toLowerCase().includes(normalized)) : projectChats
    return ['Today', 'Yesterday', 'Previous 7 days'].map((group) => ({
      group,
      chats: filtered.filter((chat) => chat.group === group),
    }))
  }, [projectChats, search])

  const openChat = (chatId: string) => {
    markChatRead(chatId)
    const existing = tabs.find((tab) => tab.chatId === chatId)
    if (existing) {
      activateTab(existing.id)
      setMobileNavOpen(false)
      return
    }
    const tab = { id: `tab-${Date.now()}`, chatId }
    const activeIndex = tabs.findIndex((item) => item.id === activeTabId)
    const next = [...tabs]
    placement === 'adjacent' ? next.splice(activeIndex + 1, 0, tab) : next.push(tab)
    setTabs(next)
    activateTab(tab.id)
    setMobileNavOpen(false)
  }
  openChatRef.current = openChat

  const createChat = (relativeToTabId = activeTabIdRef.current) => {
    if (!activeProject.id || !activeProject.verified) {
      setProjectOpen(true)
      return
    }
    const stamp = Date.now()
    const chat: Chat = {
      id: `chat-${stamp}`,
      projectId: activeProject.id,
      title: 'New conversation',
      subtitle: 'Just now',
      group: 'Today',
      provider: automaticProvider(executionProviders, fallbackProviderOrder).id,
      providerMode: 'auto',
      model: null,
      sizeTier: null,
      messages: [],
    }
    const tab = { id: `tab-${stamp}`, chatId: chat.id }
    setChats((current) => [chat, ...current])
    setTabs((current) => insertNewConversationTab(current, tab, placement, relativeToTabId))
    activateTab(tab.id)
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-chat-composer="${chat.id}"]`)?.focus())
  }

  const reorderTab = (tabId: string, targetTabId: string, position: 'before' | 'after') => {
    setTabs((current) => {
      if (tabId === targetTabId) return current
      const source = current.find((tab) => tab.id === tabId)
      if (!source || !current.some((tab) => tab.id === targetTabId)) return current

      const withoutSource = current.filter((tab) => tab.id !== tabId)
      const targetIndex = withoutSource.findIndex((tab) => tab.id === targetTabId)
      if (targetIndex < 0) return current
      const insertionIndex = targetIndex + (position === 'after' ? 1 : 0)
      const next = [...withoutSource]
      next.splice(insertionIndex, 0, source)
      return next.every((tab, index) => tab.id === current[index]?.id) ? current : next
    })
  }

  const closeTab = (tabId: string) => {
    const nextActiveTabId = activeTabIdAfterClose(projectTabs, activeTabId, tabId)
    setTabs((current) => current.filter((tab) => tab.id !== tabId))
    if (nextActiveTabId === activeTabId) return
    if (nextActiveTabId) {
      activateTab(nextActiveTabId)
      return
    }
    activeTabIdRef.current = ''
    setActiveTabId('')
  }

  const recoverProjectIntoCurrentWorkspace = (project: RelayProject) => {
    if (!isNativeWorkspaceIdentity(nativeWorkspaceIdentity)) return false
    const result = recoverFocusedProjectHistory(workspaceSnapshot, window.localStorage, {
      project,
      currentWorkspace: nativeWorkspaceIdentity,
    })
    if (!result.summary.recovered) return false

    const recovered = result.state as Partial<StoredState>
    const nextChats = (recovered.chats ?? []).map(normalizeChatModelChoice)
    const nextTabs = [...(recovered.tabs ?? [])]
    if (nextTabs.length === 0 && nextChats[0]) {
      nextTabs.push({ id: `restored-tab-${nextChats[0].id}`, chatId: nextChats[0].id })
    }
    const nextTabIds = new Set(nextTabs.map((tab) => tab.id))
    const nextActiveTabId = nextTabIds.has(recovered.activeTabId ?? '')
      ? recovered.activeTabId ?? ''
      : nextTabs[0]?.id ?? ''
    const nextDrafts = recovered.drafts ?? {}
    const nextDraftAttachments = Object.fromEntries(
      Object.entries(recovered.draftAttachments ?? {}).map(([chatId, attachments]) => [
        chatId,
        normalizeFileAttachments(attachments),
      ]),
    )
    const nextChatSessions = recovered.chatSessions ?? {}
    const nextReadCompletionByChat = recovered.readCompletionByChat ?? {}
    const nextExecutionPanelOpenByChat = normalizeExecutionPanelOpenByChat(
      recovered.executionPanelOpenByChat,
    )
    const nextChatErrors = recovered.chatErrors ?? {}
    const nextChatExecutionEvents = recovered.chatExecutionEvents ?? {}
    const nextInFlightRuns = recovered.inFlightRuns ?? {}
    const nextPromptQueues = normalizePromptQueues(recovered.promptQueues)
    // Recovery imports conversation history, not another renderer's live shell/Host authority.
    const nextOccupiedRuns: OccupiedRuns = {}

    chatsRef.current = nextChats
    tabsRef.current = nextTabs
    activeTabIdRef.current = nextActiveTabId
    draftsRef.current = nextDrafts
    draftAttachmentsRef.current = nextDraftAttachments
    projectsRef.current = [project]
    chatSessionsRef.current = nextChatSessions
    chatErrorsRef.current = nextChatErrors
    chatExecutionEventsRef.current = nextChatExecutionEvents
    inFlightRunsRef.current = nextInFlightRuns
    promptQueuesRef.current = nextPromptQueues
    occupiedRunsRef.current = nextOccupiedRuns

    setProjects([project])
    setActiveProjectId(project.id)
    setChats(nextChats)
    setTabs(nextTabs)
    setActiveTabId(nextActiveTabId)
    setDrafts(nextDrafts)
    setDraftAttachments(nextDraftAttachments)
    setChatSessions(nextChatSessions)
    setReadCompletionByChat(nextReadCompletionByChat)
    setExecutionPanelOpenByChat(nextExecutionPanelOpenByChat)
    setChatErrors(nextChatErrors)
    setChatExecutionEvents(nextChatExecutionEvents)
    setInFlightRuns(nextInFlightRuns)
    setPromptQueues(nextPromptQueues)
    setOccupiedRuns(nextOccupiedRuns)
    setSplitLayout(recovered.splitLayout)
    if (recovered.placement === 'adjacent' || recovered.placement === 'end') {
      setPlacement(recovered.placement)
    }
    if (recovered.conversationLayout === 'tabs' || recovered.conversationLayout === 'split') {
      setConversationLayout(recovered.conversationLayout)
    }
    setSearch('')
    setProjectOpen(false)

    commitWorkspace({
      projects: [project],
      activeProjectId: project.id,
      chats: nextChats,
      tabs: nextTabs,
      activeTabId: nextActiveTabId,
      drafts: nextDrafts,
      draftAttachments: nextDraftAttachments,
      chatSessions: nextChatSessions,
      readCompletionByChat: nextReadCompletionByChat,
      executionPanelOpenByChat: nextExecutionPanelOpenByChat,
      chatErrors: nextChatErrors,
      chatExecutionEvents: nextChatExecutionEvents,
      inFlightRuns: nextInFlightRuns,
      promptQueues: nextPromptQueues,
      occupiedRuns: nextOccupiedRuns,
      splitLayout: recovered.splitLayout,
      ...(recovered.placement ? { placement: recovered.placement } : {}),
      ...(recovered.conversationLayout ? { conversationLayout: recovered.conversationLayout } : {}),
    })
    void rememberNativeRecentProject(project).catch((error) => console.error('[ensync-recent-projects]', error))
    return true
  }

  const focusProject = async (project: RelayProject, allowNativeRoute = true) => {
    const workspaceHistory = {
      projects,
      chats,
      drafts,
      draftAttachments,
      chatErrors,
      chatExecutionEvents,
      inFlightRuns,
      promptQueues,
    }
    const sameProject = project.id === activeProject.id
      || (nativeProjectPathKey(project.path)
        && nativeProjectPathKey(project.path) === nativeProjectPathKey(activeProject.path))
    const activeProjectHistoryScore = workspaceProjectHistoryScore(workspaceHistory, activeProject)
    if (allowNativeRoute && !sameProject && typeof window.ensyncDesktop?.focusWorkspace === 'function') {
      let retainedWorkspaces = getRetainedNativeWorkspaces()
      try {
        retainedWorkspaces = await refreshRetainedNativeWorkspaces(window)
      } catch (error) {
        console.error('[ensync-workspace-refresh]', error)
      }
      const target = findRetainedWorkspaceForProject(window.localStorage, {
        currentWorkspace: nativeWorkspaceIdentity,
        retainedWorkspaces,
        project,
      })
      if (target) {
        try {
          const focused = await window.ensyncDesktop.focusWorkspace({
            workspaceId: target.workspace.id,
            projectId: target.projectId,
            projectPath: project.path,
          })
          if (focused) {
            setProjectOpen(false)
            return
          }
        } catch (error) {
          console.error('[ensync-workspace-focus]', error)
        }
      }
      if (activeProjectHistoryScore === 0 && recoverProjectIntoCurrentWorkspace(project)) {
        return
      }
      if (activeProjectHistoryScore > 0) {
        if (typeof window.ensyncDesktop.openProjectWorkspace !== 'function') {
          setProjectError('Quit Ensync completely and reopen it before opening another project window.')
          return
        }
        try {
          const opened = await window.ensyncDesktop.openProjectWorkspace({
            projectId: project.id,
            projectPath: project.path,
          })
          if (opened) {
            setProjectOpen(false)
          } else {
            setProjectError('Ensync could not open another project window. The current project remains open.')
          }
          return
        } catch (error) {
          console.error('[ensync-workspace-open-project]', error)
          setProjectError(error instanceof Error
            ? error.message
            : 'Ensync could not open another project window. The current project remains open.')
          return
        }
      }
    }
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)])
    setActiveProjectId(project.id)
    void rememberNativeRecentProject(project).catch((error) => console.error('[ensync-recent-projects]', error))
    const projectChatIds = new Set(chats.filter((chat) => chat.projectId === project.id).map((chat) => chat.id))
    const existingTab = tabs.find((tab) => projectChatIds.has(tab.chatId))
    if (existingTab) {
      activateTab(existingTab.id)
      setProjectOpen(false)
      return
    }
    const stamp = Date.now()
    const chat: Chat = { id: `chat-${stamp}`, projectId: project.id, title: 'New conversation', subtitle: 'Not started', group: 'Today', provider: automaticProvider(executionProviders, fallbackProviderOrder).id, providerMode: 'auto', model: null, sizeTier: null, messages: [] }
    const tab = { id: `tab-${stamp}`, chatId: chat.id }
    setChats((current) => [chat, ...current])
    setTabs((current) => [...current, tab])
    activateTab(tab.id)
    setProjectOpen(false)
  }

  focusProjectRequestRef.current = focusProject

  const inspectAndFocusProject = async (projectPath: string, allowNativeRoute = true) => {
    setProjectError(null)
    try {
      const response = await ensyncHost.inspectProject(projectPath)
      await focusProject(verifiedProject(response.project), allowNativeRoute)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ensync Host could not inspect the project folder.'
      setProjectError(message)
      throw error
    }
  }

  useEffect(() => {
    const publish = window.ensyncDesktop?.publishActiveRuns
    if (typeof publish !== 'function' || !isNativeWorkspaceIdentity(nativeWorkspaceIdentity)) return
    let cancelled = false
    let timer: number | null = null
    const publishRoster = async () => {
      if (occupiedOwnerAdoptionRef.current.size > 0) {
        if (!cancelled) timer = window.setTimeout(publishRoster, 250)
        return
      }
      const activeChatIds = chatRunRegistryRef.current.snapshot()
      const activeRuns = Object.fromEntries(Object.entries(inFlightRunsRef.current)
        .filter(([chatId]) => activeChatIds.has(chatId)))
      const bindings = activeNativeRunBindings(activeRuns, nativeWorkspaceIdentity.id)
      let accepted = false
      try {
        accepted = await publish(bindings)
      } catch (error) {
        console.error('[ensync-active-run-roster]', error)
      }
      if (cancelled || bindings.length === 0) return
      timer = window.setTimeout(publishRoster, accepted ? 5_000 : 1_000)
    }
    void publishRoster()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [inFlightRuns, nativeWorkspaceIdentity, sendingChatIds])

  useEffect(() => {
    const publish = window.ensyncDesktop?.publishActiveRuns
    return () => {
      if (typeof publish === 'function') void publish([]).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (hostOnline) {
      occupiedOwnerMissingExactJobRef.current.clear()
      return
    }
    occupiedJobProbeCoordinatorRef.current.invalidateAll()
    occupiedShellReachabilityRef.current = {}
    setOccupiedShellReachability({})
  }, [hostOnline])

  useEffect(() => () => occupiedJobProbeCoordinatorRef.current.invalidateAll(), [])

  // Mirror the Automatic ranking to the Host whenever it changes or the Host
  // reappears. Agents that run outside this window read the ranking from there,
  // so a ranking that only ever lived in this renderer would route them by the
  // shipped default instead of the choice the person actually made.
  useEffect(() => {
    if (!hostOnline) return
    void ensyncHost.saveConnectorRouting(fallbackProviderOrder).catch(() => {
      // Routing outside the app is a convenience: a Host that refuses the mirror
      // must never interrupt the conversation the person is having in it.
    })
  }, [fallbackProviderOrder, hostOnline])

  useEffect(() => {
    if (!hostOnline) return
    for (const { chatId, owner, ownerKey } of retryableOccupiedJobProbes(
      occupiedRuns,
      occupiedOwnerMissingExactJobRef.current,
    )) {
      const probe = occupiedJobProbeCoordinatorRef.current.reserve(ownerKey)
      if (!probe) continue
      const ownerTurnId = owner.turnId
      const pollCount = occupiedOwnerPollCountRef.current.get(ownerKey) ?? 0
      const delay = pollCount === 0
        ? 0
        : Math.min(10_000, 1_000 * (2 ** Math.min(pollCount - 1, 3)))
      occupiedOwnerPollCountRef.current.set(ownerKey, pollCount + 1)
      window.setTimeout(() => {
        if (!probe.start()) return
        void (async () => {
          try {
            if (occupiedRunsRef.current[chatId]?.ownerJobId !== owner.ownerJobId) return
            const response = await ensyncHost.chatJob(owner.ownerJobId)
            if (!probe.isCurrent() || response.job.id !== owner.ownerJobId) return
            occupiedOwnerMissingExactJobRef.current.delete(ownerKey)
            if (response.job.state === 'running' || response.job.state === 'completed') {
              let shellReachable = false
              if (owner.nativeWorkspaceId && typeof window.ensyncDesktop?.matchesActiveRun === 'function') {
                try {
                  shellReachable = await window.ensyncDesktop.matchesActiveRun({
                    workspaceId: owner.nativeWorkspaceId,
                    projectId: owner.projectId,
                    projectPath: owner.projectPath,
                    chatId: owner.chatId,
                    jobId: owner.ownerJobId,
                  })
                } catch {
                  shellReachable = false
                }
              }
              if (!shellReachable
                && owner.nativeWorkspaceId
                && isNativeWorkspaceIdentity(nativeWorkspaceIdentity)
                && typeof window.ensyncDesktop?.claimActiveRun === 'function'
                && typeof window.ensyncDesktop?.finalizeActiveRunClaim === 'function'
                && typeof window.ensyncDesktop?.releaseActiveRunClaim === 'function'
                && !occupiedOwnerAdoptionRef.current.has(ownerKey)) {
                const claimActiveRun = window.ensyncDesktop.claimActiveRun
                const finalizeActiveRunClaim = window.ensyncDesktop.finalizeActiveRunClaim
                const releaseActiveRunClaim = window.ensyncDesktop.releaseActiveRunClaim
                const chat = chatsRef.current.find((candidate) => candidate.id === chatId)
                const project = projectsRef.current.find((candidate) => candidate.id === owner.projectId
                  && candidate.path === owner.projectPath)
                const provider = providersRef.current.find(
                  (candidate): candidate is Provider & { id: ChatProviderId } =>
                    supportsChat(candidate) && candidate.id === owner.provider,
                )
                const jobPrefix = `job-${ownerTurnId}-${owner.provider}-`
                const attempt = Number(owner.ownerJobId.slice(jobPrefix.length))
                const candidate = chat && provider
                  && Number.isSafeInteger(attempt) && attempt > 0
                  && owner.ownerJobId === `${jobPrefix}${attempt}`
                  ? {
                      chatId: owner.chatId,
                      turnId: ownerTurnId,
                      provider: provider.id,
                      attempt,
                      jobId: owner.ownerJobId,
                    }
                  : null
                if (chat && project && candidate && executionTargetRef.current.kind === 'local') {
                  const originalTarget: NativeExactRunTarget = {
                    workspaceId: owner.nativeWorkspaceId,
                    projectId: owner.projectId,
                    projectPath: owner.projectPath,
                    chatId: owner.chatId,
                    jobId: owner.ownerJobId,
                  }
                  const replacementTarget: NativeExactRunTarget = {
                    ...originalTarget,
                    workspaceId: nativeWorkspaceIdentity.id,
                  }
                  const currentAdoptionCoordinates = () => {
                    const currentOwner = occupiedRunsRef.current[chatId]
                    const currentChat = chatsRef.current.find((current) => current.id === chatId)
                    if (!currentOwner
                      || !currentChat
                      || currentOwner.ownerJobId !== owner.ownerJobId
                      || currentOwner.turnId !== owner.turnId
                      || currentOwner.provider !== owner.provider
                      || currentOwner.targetKind !== owner.targetKind
                      || currentOwner.projectId !== owner.projectId
                      || currentOwner.projectPath !== owner.projectPath
                      || currentOwner.chatId !== owner.chatId
                      || currentOwner.nativeWorkspaceId !== owner.nativeWorkspaceId
                      || currentOwner.predecessorTranscriptFingerprint
                        !== owner.predecessorTranscriptFingerprint
                      || executionTargetRef.current.kind !== 'local'
                      || !providersRef.current.some((currentProvider) =>
                        supportsChat(currentProvider) && currentProvider.id === candidate.provider)
                      || !projectsRef.current.some((currentProject) => currentProject.id === currentOwner.projectId
                        && currentProject.path === currentOwner.projectPath)) return null
                    return { currentOwner, currentChat }
                  }
                  const prepareCurrentAdoption = async () => {
                    const before = currentAdoptionCoordinates()
                    if (!before) return null
                    const canonical = canonicalPredecessorTranscript(before.currentChat.messages, candidate.turnId)
                    if (canonical === null) return null
                    const fingerprint = await predecessorTranscriptFingerprint(
                      before.currentChat.messages,
                      candidate.turnId,
                    )
                    const after = currentAdoptionCoordinates()
                    if (!after || !fingerprint
                      || canonicalPredecessorTranscript(after.currentChat.messages, candidate.turnId) !== canonical) {
                      return null
                    }
                    const currentAdoptionRequest = {
                      candidate,
                      job: response.job,
                      projectPath: after.currentOwner.projectPath,
                      executionTarget: 'local',
                      predecessorTranscriptFingerprint: fingerprint,
                      occupied: {
                        owner: after.currentOwner,
                        replacementWorkspaceId: nativeWorkspaceIdentity.id,
                      },
                    }
                    return adoptReconnectableHostJobState({
                      chats: chatsRef.current,
                      chatErrors: chatErrorsRef.current,
                      chatExecutionEvents: chatExecutionEventsRef.current,
                      inFlightRuns: inFlightRunsRef.current,
                    }, currentAdoptionRequest)
                  }
                  const releaseClaim = async (token: string) => {
                    for (let releaseAttempt = 0; releaseAttempt < 3; releaseAttempt += 1) {
                      try {
                        if (await releaseActiveRunClaim({ token, target: replacementTarget })) return
                      } catch (error) {
                        if (releaseAttempt === 2) console.error('[ensync-active-run-claim-release]', error)
                      }
                      if (releaseAttempt < 2) {
                        await new Promise<void>((resolve) => window.setTimeout(resolve, 100 * (releaseAttempt + 1)))
                      }
                    }
                  }
                  const initialAdoption = await prepareCurrentAdoption()
                  if (initialAdoption && probe.isCurrent()) {
                    occupiedOwnerAdoptionRef.current.add(ownerKey)
                    try {
                      const claim = await claimActiveRun({ original: originalTarget, replacement: replacementTarget })
                      if (claim.status !== 'claimed' || typeof claim.token !== 'string' || !claim.token) return
                      // Claiming yields to main. Rebuild from refs so a newer
                      // transcript, error, run, or occupied owner is never
                      // overwritten by the snapshot prepared beforehand.
                      if (!probe.isCurrent() || !await prepareCurrentAdoption()) {
                        await releaseClaim(claim.token)
                        return
                      }
                      if (!await finalizeActiveRunClaim({ token: claim.token, target: replacementTarget })) {
                        await releaseClaim(claim.token)
                        return
                      }
                      const adopted = probe.isCurrent() ? await prepareCurrentAdoption() : null
                      if (!adopted) {
                        await releaseClaim(claim.token)
                        return
                      }
                      const nextOccupied = { ...occupiedRunsRef.current }
                      delete nextOccupied[chatId]
                      const nextChats = adopted.chats as Chat[]
                      const nextErrors = adopted.chatErrors
                      const nextEvents = adopted.chatExecutionEvents as Record<string, ChatExecutionEvent[]>
                      const nextRuns = adopted.inFlightRuns as Record<string, PersistedInFlightRun>
                      const recoveredRun = adopted.inFlightRun as PersistedInFlightRun
                      const persisted = commitWorkspace({
                        chats: nextChats,
                        chatErrors: nextErrors,
                        chatExecutionEvents: nextEvents,
                        inFlightRuns: nextRuns,
                        occupiedRuns: nextOccupied,
                      })
                      if (!persisted) {
                        await releaseClaim(claim.token)
                        return
                      }
                      chatsRef.current = nextChats
                      chatErrorsRef.current = nextErrors
                      chatExecutionEventsRef.current = nextEvents
                      inFlightRunsRef.current = nextRuns
                      occupiedRunsRef.current = nextOccupied
                      setChats(nextChats)
                      setChatErrors(nextErrors)
                      setChatExecutionEvents(nextEvents)
                      setInFlightRuns(nextRuns)
                      setOccupiedRuns(nextOccupied)
                      updateOccupiedShellReachability(chatId, owner.ownerJobId, false)
                      occupiedOwnerPollCountRef.current.delete(ownerKey)
                      occupiedOwnerMissingExactJobRef.current.delete(ownerKey)
                      recoverDetachedRunRef.current(chatId, recoveredRun)
                      return
                    } finally {
                      occupiedOwnerAdoptionRef.current.delete(ownerKey)
                    }
                  }
                }
              }
              if (response.job.state === 'completed') {
                const current = occupiedRunsRef.current[chatId]
                if (!current || current.ownerJobId !== owner.ownerJobId) return
                const next = applyOccupiedJobObservation(occupiedRunsRef.current, chatId, { kind: 'terminal' })
                occupiedOwnerPollCountRef.current.delete(ownerKey)
                updateOccupiedShellReachability(chatId, owner.ownerJobId, false)
                updateOccupiedRuns(next)
                commitWorkspace({ occupiedRuns: next })
                queueMicrotask(() => drainPromptQueueRef.current(chatId))
                return
              }
              const current = occupiedRunsRef.current[chatId]
              if (!current || current.ownerJobId !== owner.ownerJobId) return
              updateOccupiedShellReachability(chatId, owner.ownerJobId, shellReachable)
              const next = applyOccupiedJobObservation(occupiedRunsRef.current, chatId, {
                kind: 'running',
                providerProcessStarted: response.job.providerProcessStarted,
                steerable: response.job.steerable,
              })
              updateOccupiedRuns(next)
              commitWorkspace({ occupiedRuns: next })
              return
            }
            const current = occupiedRunsRef.current[chatId]
            if (!current || current.ownerJobId !== owner.ownerJobId) return
            const next = applyOccupiedJobObservation(occupiedRunsRef.current, chatId, { kind: 'terminal' })
            occupiedOwnerPollCountRef.current.delete(ownerKey)
            updateOccupiedShellReachability(chatId, owner.ownerJobId, false)
            updateOccupiedRuns(next)
            commitWorkspace({ occupiedRuns: next })
            queueMicrotask(() => drainPromptQueueRef.current(chatId))
          } catch (error) {
            if (!probe.isCurrent()) return
            const current = occupiedRunsRef.current[chatId]
            if (!current || current.ownerJobId !== owner.ownerJobId) return
            const missingExactJob = error instanceof EnsyncHostError
              && shouldSuppressOccupiedJobProbe(error.status)
            if (missingExactJob) occupiedOwnerMissingExactJobRef.current.add(ownerKey)
            else occupiedOwnerMissingExactJobRef.current.delete(ownerKey)
            const next = applyOccupiedJobObservation(occupiedRunsRef.current, chatId, { kind: 'unavailable' })
            if (missingExactJob) occupiedOwnerPollCountRef.current.delete(ownerKey)
            updateOccupiedShellReachability(chatId, owner.ownerJobId, false)
            updateOccupiedRuns(next)
            commitWorkspace({ occupiedRuns: next })
          } finally {
            const current = occupiedRunsRef.current[chatId]
            const retry = probe.isCurrent()
              && current?.ownerJobId === owner.ownerJobId
              && !occupiedOwnerMissingExactJobRef.current.has(ownerKey)
            probe.finish()
            if (retry) setOccupiedJobProbeRetry((currentRetry) => currentRetry + 1)
          }
        })()
      }, delay)
    }
  }, [commitWorkspace, hostOnline, nativeWorkspaceIdentity, occupiedJobProbeRetry, occupiedRuns, updateOccupiedRuns, updateOccupiedShellReachability])

  useEffect(() => window.ensyncDesktop?.onWorkspaceProjectFocus?.((request) => {
    if (!request || typeof request.projectId !== 'string' || typeof request.projectPath !== 'string') return
    if ('chatId' in request && typeof request.chatId === 'string'
      && typeof request.workspaceId === 'string') {
      if (!isNativeWorkspaceIdentity(nativeWorkspaceIdentity)) return
      const chat = chatsRef.current.find((candidate) => candidate.id === request.chatId
        && candidate.projectId === request.projectId)
      const project = projectsRef.current.find((candidate) => candidate.id === request.projectId
        && nativeProjectPathKey(candidate.path) === nativeProjectPathKey(request.projectPath))
      if (!chat || !project) return
      if (!('jobId' in request) || request.jobId === undefined) {
        if (!exactNativeChatFocusCanApply(request, {
          workspaceId: nativeWorkspaceIdentity.id,
          projectId: project.id,
          projectPath: project.path,
          chatId: chat.id,
        })) return
        setProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)])
        setActiveProjectId(project.id)
        openChatRef.current(chat.id)
        setProjectError(null)
        return
      }
      if (typeof request.jobId !== 'string') return
      const run = inFlightRunsRef.current[request.chatId]
      if (!run || !chatRunRegistryRef.current.has(chat.id)
        || run.projectId !== project.id || run.projectPath !== project.path
        || !exactNativeFocusCanApply(request, {
          workspaceId: nativeWorkspaceIdentity.id,
          projectId: project.id,
          projectPath: project.path,
          chatId: chat.id,
          jobId: run.jobId ?? '',
        })) return
      setProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)])
      setActiveProjectId(project.id)
      openChatRef.current(chat.id)
      setProjectError(null)
      return
    }
    void (async () => {
      try {
        const response = await ensyncHost.inspectProject(request.projectPath)
        await focusProjectRequestRef.current(verifiedProject(response.project), false)
        setProjectError(null)
      } catch (error) {
        const path = nativeProjectPathKey(request.projectPath)
        const remembered = projectsRef.current.find((project) => project.id === request.projectId
          || (path && nativeProjectPathKey(project.path) === path))
        if (remembered) await focusProjectRequestRef.current(remembered, false)
        setProjectError(error instanceof Error ? error.message : 'Ensync Host could not recheck the focused project.')
      }
    })()
  }), [nativeWorkspaceIdentity])

  const setChatProvider = (chatId: string, providerId: ProviderId) => {
    setChats((current) => current.map((chat) => (chat.id === chatId ? { ...chat, provider: providerId, providerMode: 'fixed', model: null } : chat)))
    setProviderMenuChatId(null)
    setModelMenuChatId(null)
  }

  const setChatAutoProvider = (chatId: string) => {
    const selected = automaticProvider(executionProviders, fallbackProviderOrder)
    setChats((current) => current.map((chat) => (chat.id === chatId ? { ...chat, provider: selected.id, providerMode: 'auto', model: null } : chat)))
    setProviderMenuChatId(null)
    setModelMenuChatId(null)
  }

  const setChatSizeTier = (chatId: string, sizeTier: ModelSizeTier | null) => {
    setChats((current) => current.map((chat) => {
      if (chat.id !== chatId) return chat
      return { ...chat, model: null, sizeTier }
    }))
    setModelMenuChatId(null)
  }

  const setAutoContextSkillEnabled = (enabled: boolean) => {
    setAutoContextSkill(enabled)
    setProviderMenuChatId(null)
    setModelMenuChatId(null)
  }

  const startSupportRepair = async ({ report, prompt }: Parameters<NonNullable<React.ComponentProps<typeof SupportDesk>['onStartAiRepair']>>[0]) => {
    if (!supportRepairAvailable || (supportProvider.id !== 'codex' && supportProvider.id !== 'claude')) {
      throw new Error('AI repair requires a verified local project and a connected Codex or Claude subscription with available usage.')
    }
    const stamp = Date.now()
    const chatId = `support-repair-${stamp}`
    const agentWorkspaceKey = conversationWorkspaceKey(chatId)
    const result = await supportRepairHost.run({
      provider: supportProvider.id,
      projectId: activeProject.id,
      projectPath: activeProject.path,
      workspaceKey: agentWorkspaceKey,
      prompt,
      diagnostics: {
        summary: report.ticket.summary,
        details: report.ticket.description,
      },
      consent: {
        fixWithMySubscription: true,
        allowProjectEdits: true,
      },
      model: null,
      sessionId: null,
    })

    const tabId = `tab-${stamp}`
    const repairChat: Chat = {
      id: chatId,
      agentWorkspaceKey,
      projectId: activeProject.id,
      title: `Bug repair: ${report.ticket.summary}`.slice(0, 52),
      subtitle: 'Review required',
      group: 'Today',
      provider: result.run.provider,
      providerMode: 'fixed',
      model: result.run.requestedModel,
      workspace: result.run.workspace
        ? { path: result.run.workspace.path, branch: result.run.workspace.branch }
        : null,
      messages: [
        { id: `msg-${stamp}-report`, role: 'user', content: `Support report: ${report.ticket.summary}`, time: timeNow() },
        { id: `msg-${stamp}-repair`, role: 'agent', provider: result.run.provider, content: result.run.response, time: timeNow() },
      ],
    }
    const activeIndex = tabs.findIndex((item) => item.id === activeTabId)
    const nextTabs = [...tabs]
    const repairTab = { id: tabId, chatId }
    placement === 'adjacent' ? nextTabs.splice(activeIndex + 1, 0, repairTab) : nextTabs.push(repairTab)
    setChats((current) => [repairChat, ...current])
    setTabs(nextTabs)
    activeTabIdRef.current = tabId
    setActiveTabId(tabId)
    setReadCompletionByChat((current) => markCompletionRead(current, chatId, `msg-${stamp}-repair`))
    if (result.run.sessionId) {
      setChatSessions((current) => ({
        ...current,
        [chatId]: { provider: result.run.provider, sessionId: result.run.sessionId!, targetKey: currentTargetKey, syncedMessageCount: 2 },
      }))
    }
    if (result.run.usage) {
      const usage = result.run.usage
      const model = result.run.model ?? result.run.requestedModel ?? 'Model not reported by CLI'
      const add = (left: number | null, right: number | null) => left === null && right === null ? null : (left ?? 0) + (right ?? 0)
      setModelTelemetry((current) => {
        const existing = current.find((item) => item.provider === result.run.provider && item.model === model)
        const next: ModelTelemetry = existing ? {
          ...existing,
          inputTokens: add(existing.inputTokens, usage.inputTokens),
          outputTokens: add(existing.outputTokens, usage.outputTokens),
          cachedInputTokens: add(existing.cachedInputTokens, usage.cachedInputTokens),
          runs: existing.runs + 1,
          lastRunAt: result.run.completedAt,
        } : {
          provider: result.run.provider,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          runs: 1,
          lastRunAt: result.run.completedAt,
        }
        return [...current.filter((item) => !(item.provider === result.run.provider && item.model === model)), next]
      })
    }
    void refreshProviders(false)
  }

  const recordRunUsage = useCallback((result: ChatRunResponse) => {
    if (!result.usage) return
    const usage = result.usage
    const model = result.model ?? result.requestedModel ?? 'Model not reported by CLI'
    const add = (left: number | null, right: number | null) => left === null && right === null ? null : (left ?? 0) + (right ?? 0)
    setModelTelemetry((current) => {
      const existing = current.find((item) => item.provider === result.provider && item.model === model)
      const next: ModelTelemetry = existing ? {
        ...existing,
        inputTokens: add(existing.inputTokens, usage.inputTokens),
        outputTokens: add(existing.outputTokens, usage.outputTokens),
        cachedInputTokens: add(existing.cachedInputTokens, usage.cachedInputTokens),
        runs: existing.runs + 1,
        lastRunAt: result.completedAt,
      } : {
        provider: result.provider,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        runs: 1,
        lastRunAt: result.completedAt,
      }
      return [...current.filter((item) => !(item.provider === result.provider && item.model === model)), next]
    })
  }, [])

  const completeChatRun = useCallback(async ({
    chatId,
    turnId,
    result,
    runTargetKey,
    projectPath,
    priorMessageCount,
    continuityCapsuleUsed,
    attemptedProviders,
    fallbackReason,
    gitBefore,
    gitReason,
  }: {
    chatId: string
    turnId: string
    result: ChatRunResponse
    runTargetKey: string
    projectPath: string | null
    priorMessageCount: number
    continuityCapsuleUsed: boolean
    attemptedProviders: ChatProviderId[]
    fallbackReason: string | null
    gitBefore: ReturnType<typeof continuationGit>
    gitReason: string
  }) => {
    let gitAfter: GitStatus | null = null
    let gitAfterReason = gitReason
    const effectiveProjectPath = result.workspace?.path ?? projectPath
    const effectiveGitBefore = result.workspace?.gitBefore ? {
      branch: result.workspace.gitBefore.branch,
      dirty: result.workspace.gitBefore.dirty,
      changedFiles: result.workspace.gitBefore.changedFiles,
      checkedAt: result.workspace.gitBefore.checkedAt,
    } : gitBefore
    if (continuityCapsuleUsed && runTargetKey === 'local' && effectiveProjectPath) {
      try {
        const response = await ensyncHost.gitStatus(effectiveProjectPath)
        gitAfter = response.git
        gitAfterReason = ''
      } catch (gitError) {
        gitAfterReason = gitError instanceof Error ? gitError.message : 'Ensync Host could not verify Git status after the run'
      }
    }

    const turnUserMessageCount = chatsRef.current
      .find((chat) => chat.id === chatId)
      ?.messages.filter((message) => message.role === 'user' && message.turnId === turnId).length ?? 1
    const nextSessions = { ...chatSessionsRef.current }
    if (result.sessionId) {
      nextSessions[chatId] = {
        provider: result.provider,
        sessionId: result.sessionId,
        targetKey: runTargetKey,
        syncedMessageCount: priorMessageCount + turnUserMessageCount + 1,
      }
    } else {
      delete nextSessions[chatId]
    }
    chatSessionsRef.current = nextSessions
    setChatSessions(nextSessions)
    const completionAlreadyApplied = chatsRef.current
      .find((chat) => chat.id === chatId)
      ?.messages.some((message) => message.role === 'agent' && message.turnId === turnId) === true
    if (!completionAlreadyApplied) recordRunUsage(result)

    const extractedResponse = extractEnsyncContinuation(result.response)
    const agentMessageId = `msg-${turnId}-agent`
    const completedChats = chatsRef.current.map((chat) => {
      if (chat.id !== chatId) return chat
      const completedMessages = chat.messages.map((messageItem) => messageItem.turnId === turnId && messageItem.role === 'user'
        ? { ...messageItem, deliveryStatus: 'completed' as const }
        : messageItem)
      const messages = completedMessages.some((messageItem) => messageItem.role === 'agent' && messageItem.turnId === turnId)
        ? completedMessages
        : insertAgentReplyBeforeLaterQueued(completedMessages, turnId, {
            id: agentMessageId,
            role: 'agent',
            turnId,
            provider: result.provider,
            model: result.model,
            sizeTier: sizeTierForEffort(result.requestedEffort),
            executionTarget: runTargetKey,
            sessionResumable: Boolean(result.sessionId),
            content: extractedResponse.visibleResponse,
            time: timeNow(),
          })
      return {
        ...chat,
        subtitle: 'Updated just now',
        messages,
        workspace: result.workspace
          ? { path: result.workspace.path, branch: result.workspace.branch }
          : chat.workspace,
        model: null,
        sizeTier: chat.sizeTier ?? null,
        continuation: continuityCapsuleUsed ? {
          turnId,
          status: 'completed' as const,
          provider: result.provider,
          model: result.model,
          sizeTier: sizeTierForEffort(result.requestedEffort),
          executionTarget: runTargetKey,
          sessionResumable: Boolean(result.sessionId),
          attemptedProviders,
          fallbackReason,
          completedAt: result.completedAt,
          workspace: result.workspace
            ? { path: result.workspace.path, branch: result.workspace.branch }
            : chat.continuation?.workspace ?? null,
          gitBefore: effectiveGitBefore,
          gitAfter: continuationGit(gitAfter),
          gitReason: gitAfterReason || null,
          semanticSummary: extractedResponse.semanticSummary,
        } : chat.continuation,
      }
    })
    chatsRef.current = completedChats
    setChats(completedChats)
    updateChatError(chatId, null)

    const activeChatId = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current)?.chatId
    if (activeChatId === chatId) {
      setReadCompletionByChat((current) => markCompletionRead(current, chatId, agentMessageId))
    }
    if (!completionAlreadyApplied) void notifyCompletion()
  }, [notifyCompletion, recordRunUsage, updateChatError])

  const markDetachedRunInterrupted = useCallback((chatId: string, run: PersistedInFlightRun) => {
    const interruptedAt = new Date().toISOString()
    const nextSessions = { ...chatSessionsRef.current }
    delete nextSessions[chatId]
    chatSessionsRef.current = nextSessions
    setChatSessions(nextSessions)
    const nextChats = chatsRef.current.map((chat) => chat.id === chatId ? {
      ...chat,
      subtitle: 'Interrupted by restart',
      messages: chat.messages.map((message) => message.role === 'user'
        && message.turnId === run.turnId
        && message.deliveryStatus === 'pending'
        ? { ...message, deliveryStatus: 'interrupted' as const }
        : message),
      continuation: {
        turnId: run.turnId,
        status: 'reconciliation_required' as const,
        termination: 'interrupted' as const,
        reconciliationRequired: true,
        provider: run.provider,
        model: null,
        sizeTier: run.sizeTier,
        executionTarget: run.executionTarget,
        sessionResumable: false,
        attemptedProviders: run.attemptedProviders,
        fallbackReason: run.fallbackReason,
        completedAt: interruptedAt,
        gitBefore: run.gitBefore,
        gitAfter: null,
        gitReason: INTERRUPTION_MESSAGE,
        semanticSummary: chat.continuation?.semanticSummary ?? null,
      },
    } : chat)
    chatsRef.current = nextChats
    setChats(nextChats)
    updateChatError(chatId, INTERRUPTION_MESSAGE)
    const lastEvent = chatExecutionEventsRef.current[chatId]?.at(-1)
    if (!(lastEvent?.type === 'finished' && lastEvent.code === 'run_interrupted')) {
      appendChatExecutionEvent(chatId, {
        type: 'finished',
        outcome: 'interrupted',
        message: INTERRUPTION_MESSAGE,
        code: 'run_interrupted',
        safeToRetry: false,
        at: interruptedAt,
      })
    }
  }, [appendChatExecutionEvent, updateChatError])

  const finishDetachedRunFailure = useCallback((chatId: string, run: PersistedInFlightRun, error: unknown, cancelled: boolean) => {
    const failedAt = new Date().toISOString()
    const failureMessage = error instanceof Error ? error.message : 'The Ensync Host run failed.'
    const currentRun = inFlightRunsRef.current[chatId] ?? run
    const nextSessions = { ...chatSessionsRef.current }
    delete nextSessions[chatId]
    chatSessionsRef.current = nextSessions
    setChatSessions(nextSessions)
    const nextChats = chatsRef.current.map((chat) => {
      if (chat.id !== chatId) return chat
      if (cancelled) {
        return {
          ...chat,
          subtitle: 'Stopped by you',
          messages: chat.messages.map((message) => message.role === 'user' && message.turnId === run.turnId
            ? { ...message, deliveryStatus: 'cancelled' as const }
            : message),
          continuation: {
            turnId: run.turnId,
            status: currentRun.providerProcessStarted ? 'reconciliation_required' as const : 'cancelled' as const,
            termination: 'cancelled' as const,
            reconciliationRequired: currentRun.providerProcessStarted,
            provider: currentRun.provider,
            model: null,
            sizeTier: currentRun.sizeTier,
            executionTarget: currentRun.executionTarget,
            sessionResumable: false,
            attemptedProviders: currentRun.attemptedProviders,
            fallbackReason: currentRun.fallbackReason,
            completedAt: failedAt,
            gitBefore: currentRun.gitBefore,
            gitAfter: null,
            gitReason: currentRun.providerProcessStarted
              ? 'The provider run was stopped after it began. File or command activity may be partial and must be reconciled before retrying.'
              : 'The run was stopped before Ensync Host reported that the provider process started.',
            semanticSummary: null,
          },
        }
      }
      return {
        ...chat,
        subtitle: 'Run failed',
        messages: chat.messages.map((message) => message.role === 'user' && message.turnId === run.turnId
          ? { ...message, deliveryStatus: 'failed' as const }
          : message),
        continuation: currentRun.continuityStateRequired ? {
          turnId: run.turnId,
          status: runNeedsReconciliation(error) ? 'reconciliation_required' as const : 'blocked' as const,
          provider: currentRun.provider,
          model: null,
          sizeTier: currentRun.sizeTier,
          executionTarget: currentRun.executionTarget,
          sessionResumable: false,
          attemptedProviders: currentRun.attemptedProviders,
          fallbackReason: currentRun.fallbackReason ?? failureMessage,
          completedAt: failedAt,
          gitBefore: currentRun.gitBefore,
          gitAfter: null,
          gitReason: currentRun.gitReason || 'Git state after the failed run was not verified',
        } : chat.continuation,
      }
    })
    chatsRef.current = nextChats
    setChats(nextChats)
    updateChatError(chatId, cancelled ? null : failureMessage)
  }, [updateChatError])

  const handleStop = (chatId: string) => {
    // A plain Stop must never advance the queue; only stop-and-send arms that.
    stopAndSendChatIdsRef.current.delete(chatId)
    chatRunCancellationRef.current.stop(chatId)
  }

  /**
   * The honest analogue of Push now on providers that cannot be steered: end
   * the running turn and run the queued head immediately. The turn's
   * in-progress work is discarded, so this records the same explicit approval
   * as "Run next message anyway" before stopping — the stopped predecessor is
   * never retried, and only the head advances.
   */
  const handleStopAndSendNow = (chatId: string) => {
    const entry = promptQueuesRef.current[chatId]?.[0]
    const activeRun = inFlightRunsRef.current[chatId]
    if (!entry || !activeRun) return
    if (!queuedPromptCanStopAndSendNow(entry, activeRun, {
      liveSteerAvailable: activeRun.liveSteerReady === true && activeRun.provider === 'codex',
    })) {
      updateChatError(chatId, 'This queued message can no longer be matched to the running turn. It remains safely queued.')
      return
    }

    const nextQueues = approveNextQueuedPrompt(promptQueuesRef.current, chatId, new Date().toISOString())
    updatePromptQueues(nextQueues)
    const nextErrors = updateChatError(chatId, null)
    commitWorkspace({ promptQueues: nextQueues, chatErrors: nextErrors })
    stopAndSendChatIdsRef.current.add(chatId)
    chatRunCancellationRef.current.stop(chatId)
  }
  stopAndSendNowRef.current = handleStopAndSendNow

  const handleFilesDrop = async (chatId: string, files: FileList) => {
    if (executionTargetRef.current.kind !== 'local') {
      setAttachmentErrors((current) => ({
        ...current,
        [chatId]: 'These files are on this computer. Switch the chat to the local Ensync Host before attaching them.',
      }))
      return
    }

    // Snapshot synchronously: the DataTransfer list empties as soon as this
    // handler yields, and a file the OS hides from every other process (a
    // screenshot dragged from the macOS thumbnail, for example) is readable
    // only through these File objects, only right now. resolveDroppedAttachments
    // copies exactly those through the host so the agent gets a readable path.
    const droppedFiles = Array.from(files)
    // Nothing awaits this handler, so an escaping rejection would drop the
    // files with no visible trace at all.
    const dropped = await resolveDroppedAttachments(droppedFiles, window.ensyncDesktop?.getPathForFile, {
      probeAttachmentPaths: (paths: string[]) => ensyncHost.probeAttachmentPaths(paths),
      storeChatAttachment: (name: string, bytes: ArrayBuffer) => ensyncHost.storeChatAttachment(name, bytes),
    }).catch(() => null)
    if (!dropped) {
      setAttachmentErrors((current) => ({
        ...current,
        [chatId]: 'Ensync could not attach the dropped files. Drop them again.',
      }))
      return
    }
    if (!chatsRef.current.some((chat) => chat.id === chatId)) return
    if (executionTargetRef.current.kind !== 'local') {
      setAttachmentErrors((current) => ({
        ...current,
        [chatId]: 'The execution target changed while these files were being attached. Switch back to the local Ensync Host to attach them.',
      }))
      return
    }
    if (dropped.attachments.length > 0) {
      const nextAttachments = {
        ...draftAttachmentsRef.current,
        [chatId]: appendFileAttachments(draftAttachmentsRef.current[chatId], dropped.attachments),
      }
      draftAttachmentsRef.current = nextAttachments
      setDraftAttachments(nextAttachments)
      setAttachmentErrors((current) => ({ ...current, [chatId]: null }))
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(`[data-chat-composer="${chatId}"]`)?.focus()
      })
    }
    if (dropped.unavailable.length > 0) {
      setAttachmentErrors((current) => ({
        ...current,
        [chatId]: window.ensyncDesktop?.getPathForFile
          ? `Ensync could not attach ${dropped.unavailable.length === 1 ? dropped.unavailable[0] : `${dropped.unavailable.length} dropped files`}. Drop them again, or save them somewhere Ensync can read.`
          : 'File drag-in is available in the native Ensync app; browsers do not expose safe local file paths.',
      }))
    }
  }

  const handleFilesChoose = async (chatId: string) => {
    if (executionTargetRef.current.kind !== 'local') {
      setAttachmentErrors((current) => ({
        ...current,
        [chatId]: 'These files are on this computer. Switch the chat to the local Ensync Host before attaching them.',
      }))
      return
    }

    const chooseChatFiles = window.ensyncDesktop?.chooseChatFiles
    if (typeof chooseChatFiles !== 'function') {
      setAttachmentErrors((current) => ({
        ...current,
        [chatId]: 'File selection is available in the native Ensync app; browsers do not expose safe local file paths.',
      }))
      return
    }

    try {
      const result = await chooseChatFiles()
      if (result?.status === 'cancelled') return
      if (result?.status === 'error') {
        setAttachmentErrors((current) => ({ ...current, [chatId]: result.message }))
        return
      }
      const selected = normalizeFileAttachments(result?.status === 'selected' ? result.files : [])
      if (!chatsRef.current.some((chat) => chat.id === chatId)) return
      if (executionTargetRef.current.kind !== 'local') {
        setAttachmentErrors((current) => ({
          ...current,
          [chatId]: 'The execution target changed while files were being selected. Switch back to the local Ensync Host to attach them.',
        }))
        return
      }
      if (selected.length === 0) {
        setAttachmentErrors((current) => ({
          ...current,
          [chatId]: 'Ensync could not read the files returned by the system file chooser.',
        }))
        return
      }

      const nextAttachments = {
        ...draftAttachmentsRef.current,
        [chatId]: appendFileAttachments(draftAttachmentsRef.current[chatId], selected),
      }
      draftAttachmentsRef.current = nextAttachments
      setDraftAttachments(nextAttachments)
      setAttachmentErrors((current) => ({ ...current, [chatId]: null }))
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(`[data-chat-composer="${chatId}"]`)?.focus()
      })
    } catch {
      setAttachmentErrors((current) => ({
        ...current,
        [chatId]: 'Ensync could not open the system file chooser.',
      }))
    }
  }

  const updatePromptQueues = (next: PromptQueues) => {
    promptQueuesRef.current = next
    setPromptQueues(next)
  }

  const handleSend = async (chatId: string, queuedPrompt?: QueuedPrompt) => {
    const turnId = queuedPrompt?.turnId ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const chatToSendCurrent = chatsRef.current.find((chat) => chat.id === chatId)
    const message = (queuedPrompt?.prompt ?? draftsRef.current[chatId] ?? '').trim()
    const attachments = normalizeFileAttachments(
      queuedPrompt?.attachments ?? draftAttachmentsRef.current[chatId] ?? [],
    )
    const providerPrompt = messageTextWithAttachments(message, attachments)
    if (!providerPrompt || !chatToSendCurrent) return
    const runTarget = executionTargetRef.current
    let runProject = queuedPrompt
      ? projectsRef.current.find((project) => project.id === queuedPrompt.preferences.projectId
        && project.path === queuedPrompt.preferences.projectPath)
      : projectsRef.current.find((project) => project.id === chatToSendCurrent.projectId)
    if (queuedPrompt && targetKey(runTarget) !== queuedPrompt.preferences.executionTargetKey) {
      setChatErrors((current) => ({
        ...current,
        [chatId]: `Queue paused: reconnect the exact ${queuedPrompt.preferences.executionTargetKey} target. Ensync will not run this message on another computer.`,
      }))
      return
    }
    if (attachments.length > 0 && runTarget.kind !== 'local') {
      setChatErrors((current) => ({
        ...current,
        [chatId]: 'These files are on this computer and cannot be attached to an SSH run. Remove them or switch this chat back to the local Ensync Host.',
      }))
      return
    }
    const chatToSend: Chat = queuedPrompt ? {
      ...chatToSendCurrent,
      provider: queuedPrompt.preferences.provider,
      providerMode: queuedPrompt.preferences.providerMode,
      sizeTier: queuedPrompt.preferences.sizeTier,
      messages: transcriptMessagesBeforeTurn(chatToSendCurrent.messages, turnId),
    } : chatToSendCurrent
    const runTargetKey = targetKey(runTarget)
    let runExecutionProviders = providersForTarget(providersRef.current, runTarget)
    const runFallbackOrder = queuedPrompt?.preferences.fallbackProviderOrder ?? fallbackProviderOrder
    const runAutoFallback = queuedPrompt?.preferences.automaticFallback ?? autoFallback
    const runAutoContext = queuedPrompt?.preferences.autoContextSkill ?? autoContextSkill
    if (!chatToSend) return
    if (!runProject?.id || chatToSend.projectId !== runProject.id) {
      setChatErrors((current) => ({ ...current, [chatId]: 'Re-open the project through Ensync Host before running this chat.' }))
      return
    }
    if (!runProject.verified) {
      try {
        const response = await ensyncHost.inspectProject(runProject.path)
        const inspectedProject = verifiedProject(response.project)
        if (inspectedProject.id !== runProject.id) {
          setChatErrors((current) => ({ ...current, [chatId]: 'The project folder now resolves to a different Ensync project. Review and focus it before running this chat.' }))
          return
        }
        runProject = inspectedProject
        const nextProjects = [
          inspectedProject,
          ...projectsRef.current.filter((project) => project.id !== inspectedProject.id),
        ]
        projectsRef.current = nextProjects
        setProjects(nextProjects)
        void rememberNativeRecentProject(inspectedProject).catch((error) => console.error('[ensync-recent-projects]', error))
      } catch (error) {
        setChatErrors((current) => ({
          ...current,
          [chatId]: error instanceof Error
            ? error.message
            : 'Ensync Host could not re-verify the project before this run.',
        }))
        return
      }
    }
    const runPreferences = chatRunPreferences(chatToSend, runAutoFallback)
    const agentWorkspaceKey = resolveConversationWorkspaceKey(chatToSend)
    const automaticMode = runPreferences.automaticProvider
    const enqueueBehindActiveRun = promptSubmissionMode({
      hasActiveRun: !queuedPrompt && chatRunRegistryRef.current.has(chatId),
    }) === 'queue'
    const selectedAutomaticProvider = selectAutomaticProvider(runExecutionProviders, runFallbackOrder)
    if (automaticMode && !selectedAutomaticProvider && !enqueueBehindActiveRun) {
      setChatErrors((current) => ({ ...current, [chatId]: 'Auto found no connected, tested provider with verified remaining or unreported subscription usage. Check Automatic fallback in Settings or connect Codex, Claude Code, or Factory Droid.' }))
      return
    }
    const provider = automaticMode
      ? selectedAutomaticProvider ?? providerForChat(runExecutionProviders, chatToSend, runFallbackOrder)
      : providerForChat(runExecutionProviders, chatToSend, runFallbackOrder)
    if (!supportsChat(provider) && !enqueueBehindActiveRun) {
      setChatErrors((current) => ({ ...current, [chatId]: `${provider.name} chat execution is not supported by Ensync Host yet. Choose Codex, Claude Code, or Factory Droid.` }))
      return
    }
    if (enqueueBehindActiveRun) {
      const queuedAt = new Date().toISOString()
      const queue = promptQueuesRef.current[chatId] ?? []
      const messageId = `msg-${turnId}`
      const entry: QueuedPrompt = {
        id: `queue-${turnId}`,
        turnId,
        messageId,
        prompt: message,
        attachments,
        enqueuedAt: queuedAt,
        predecessorTurnId: predecessorTurnIdForPrompt(queue, chatToSendCurrent.messages, {
          turnId: activeTurnIdsRef.current[chatId] ?? inFlightRunsRef.current[chatId]?.turnId,
        }),
        preferences: {
          providerMode: chatToSendCurrent.providerMode ?? 'auto',
          provider: chatToSendCurrent.provider,
          sizeTier: chatToSendCurrent.sizeTier ?? null,
          automaticFallback: autoFallback,
          autoContextSkill,
          fallbackProviderOrder: [...fallbackProviderOrder],
          executionTargetKey: targetKey(runTarget),
          projectId: runProject.id,
          projectPath: runProject.path,
        },
      }
      updatePromptQueues(appendPromptToQueue(promptQueuesRef.current, chatId, entry))
      const nextChats = chatsRef.current.map((chat) => chat.id === chatId ? {
        ...chat,
        messages: [...chat.messages, {
          id: messageId,
          role: 'user' as const,
          content: visibleMessageText(message, attachments),
          attachments,
          time: timeNow(),
          turnId,
          deliveryStatus: 'queued' as const,
        }],
      } : chat)
      chatsRef.current = nextChats
      setChats(nextChats)
      if ((draftsRef.current[chatId] ?? '').trim() === message) {
        draftsRef.current = { ...draftsRef.current, [chatId]: '' }
        setDrafts(draftsRef.current)
      }
      if ((draftAttachmentsRef.current[chatId] ?? []).every((attachment, index) =>
        attachment.path === attachments[index]?.path)) {
        draftAttachmentsRef.current = { ...draftAttachmentsRef.current, [chatId]: [] }
        setDraftAttachments(draftAttachmentsRef.current)
      }
      setChatErrors((current) => ({ ...current, [chatId]: null }))
      return
    }
    if (!chatRunRegistryRef.current.begin(chatId)) return
    activeTurnIdsRef.current[chatId] = turnId
    if (queuedPrompt) {
      updatePromptQueues(removePromptFromQueue(promptQueuesRef.current, chatId, queuedPrompt.id))
    }
    const runController = chatRunCancellationRef.current.begin(chatId)
    const runStartedAt = new Date().toISOString()
    if (completionNotificationSettings.mode === 'ringtone') void primeCompletionNotifications()
    setSendingChatIds(chatRunRegistryRef.current.snapshot())
    setVerifiedRetryableChatIds(withoutChatId(chatId))
    updateInFlightRun(chatId, () => ({
        turnId,
        provider: provider.id as ChatProviderId,
        sizeTier: chatToSend.sizeTier ?? null,
        executionTarget: runTargetKey,
        attemptedProviders: [],
        fallbackReason: null,
        providerProcessStarted: false,
        startedAt: runStartedAt,
        gitBefore: continuationGit(null),
        projectId: runProject.id,
        projectPath: runProject.path,
        liveSteerReady: false,
        continuityStateRequired: runAutoContext || runPreferences.fallbackEnabled,
        gitReason: runTarget.kind === 'ssh'
          ? 'the current SSH probe verifies Git availability but does not report branch/worktree status'
          : 'Git status was not requested',
      }))
    chatExecutionEventsRef.current = { ...chatExecutionEventsRef.current, [chatId]: [] }
    setChatExecutionEvents(chatExecutionEventsRef.current)
    updateChatError(chatId, null)
    let routedProvider = provider
    const attemptedProviders: ChatProviderId[] = []
    let fallbackReason: string | null = null
    let handoffGitStatus: GitStatus | null = null
    let handoffGitStatusReason = runTarget.kind === 'ssh'
      ? 'the current SSH probe verifies Git availability but does not report branch/worktree status'
      : 'Git status was not requested'
    const fallbackEnabled = runPreferences.fallbackEnabled
    const continuityStateRequired = runAutoContext || fallbackEnabled
    let providerProcessStarted = false
    if (continuityStateRequired && runTarget.kind === 'local') {
      try {
        const response = await ensyncHost.gitStatus(runProject.path)
        handoffGitStatus = response.git
        handoffGitStatusReason = ''
      } catch (gitError) {
        handoffGitStatusReason = gitError instanceof Error ? gitError.message : 'Ensync Host could not verify Git status'
      }
    }
    if (fallbackEnabled && provider.usage !== null && provider.usage >= 100) {
      const availableFallback = selectAutomaticProvider(runExecutionProviders, runFallbackOrder, [provider.id])
      if (availableFallback) {
        fallbackReason = `${provider.name} reported 100% used before this turn, so Ensync routed to ${availableFallback.name}.`
        routedProvider = availableFallback
      }
    }
    updateInFlightRun(chatId, () => ({
        turnId,
        provider: routedProvider.id as ChatProviderId,
        sizeTier: chatToSend.sizeTier ?? null,
        executionTarget: runTargetKey,
        attemptedProviders: [],
        fallbackReason,
        providerProcessStarted: false,
        startedAt: runStartedAt,
        gitBefore: continuationGit(handoffGitStatus),
        projectId: runProject.id,
        projectPath: runProject.path,
        liveSteerReady: false,
        continuityStateRequired: runAutoContext || fallbackReason !== null,
        gitReason: handoffGitStatusReason,
      }))
    const firstMessage = chatToSend.messages.length === 0
    const runningChats = chatsRef.current.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              agentWorkspaceKey,
              title: firstMessage ? visibleMessageText(message, attachments).slice(0, 36) : chat.title,
              subtitle: 'Working now',
              model: null,
              messages: queuedPrompt
                ? chat.messages.map((item) => item.id === queuedPrompt.messageId
                  ? { ...item, deliveryStatus: 'pending' as const }
                  : item)
                : [...chat.messages, {
                    id: `msg-${turnId}`,
                    role: 'user' as const,
                    content: visibleMessageText(message, attachments),
                    attachments,
                    time: timeNow(),
                    turnId,
                    deliveryStatus: 'pending' as const,
                  }],
            }
          : chat,
      )
    chatsRef.current = runningChats
    setChats(runningChats)
    draftsRef.current = { ...draftsRef.current, [chatId]: '' }
    setDrafts(draftsRef.current)
    draftAttachmentsRef.current = { ...draftAttachmentsRef.current, [chatId]: [] }
    setDraftAttachments(draftAttachmentsRef.current)
    const predecessorFingerprintPromise = predecessorTranscriptFingerprint(
      runningChats.find((current) => current.id === chatId)?.messages ?? [],
      turnId,
    )

    const run = async (target: Provider, prompt: string) => {
      if (!supportsChat(target)) throw new Error(`${target.name} chat execution is not supported.`)
      const targetProviderId: ChatProviderId = target.id
      if (!attemptedProviders.includes(targetProviderId)) attemptedProviders.push(targetProviderId)
      const session = chatSessionsRef.current[chatId]
      const transcript = chatToSend.messages.map((item) => `${item.role === 'user'
        ? item.deliveryStatus === 'failed'
          ? 'User (failed attempt; context only, do not execute)'
          : item.deliveryStatus === 'cancelled'
            ? 'User (stopped attempt; context only, do not execute)'
            : item.deliveryStatus === 'interrupted'
              ? 'User (interrupted attempt; context only, do not execute)'
            : 'User'
        : `Agent${item.provider ? ` (${item.provider})` : ''}`}: ${item.role === 'user'
          ? messageTextWithAttachments(item.content, item.attachments)
          : item.content}`).join('\n\n')
      const canResume = session?.provider === target.id
        && session.targetKey === runTargetKey
        && session.syncedMessageCount === chatToSend.messages.length
      const continuityCapsuleRequired = runAutoContext
        || fallbackReason !== null
        || attemptedProviders.length > 1
      const basePrompt = continuityCapsuleRequired
        ? buildAutoContextPrompt({
            project: runProject,
            target: runTarget,
            chat: chatToSend,
            prompt,
            includeTranscript: !canResume,
            gitStatus: handoffGitStatus,
            gitStatusReason: handoffGitStatusReason,
            providerMode: chatToSend.providerMode ?? 'auto',
          })
        : canResume || !transcript ? prompt : `${transcript}\n\nUser: ${prompt}`
      const effectivePrompt = basePrompt
      const requestedModel = null
      const requestedEffort = runPreferences.requestedEffort
      const jobId = `job-${turnId}-${targetProviderId}-${attemptedProviders.length}`
      return beginRunAfterPredecessorFingerprint(
        predecessorFingerprintPromise,
        runController.signal,
        async (predecessorFingerprint) => {
          if (runController.signal.aborted) throw cancelledRunError()
          if (runTarget.kind === 'ssh') providerProcessStarted = true
          const nextRuns = updateInFlightRun(chatId, (current) => ({
            ...(current ?? {
              turnId,
              sizeTier: chatToSend.sizeTier ?? null,
              executionTarget: runTargetKey,
              providerProcessStarted: false,
              startedAt: runStartedAt,
              gitBefore: continuationGit(handoffGitStatus),
            }),
            provider: targetProviderId,
            attemptedProviders: [...attemptedProviders],
            fallbackReason,
            providerProcessStarted: runTarget.kind === 'ssh' || current?.providerProcessStarted === true,
            jobId,
            lastEventSequence: 0,
            projectId: runProject.id,
            projectPath: runProject.path,
            liveSteerReady: false,
            continuityStateRequired: continuityCapsuleRequired,
            gitReason: handoffGitStatusReason,
          }))
          // Persist the reconnect key and pending user turn before the Host is
          // allowed to start a provider process.
          commitWorkspace({
            chats: chatsRef.current,
            chatExecutionEvents: chatExecutionEventsRef.current,
            chatErrors: chatErrorsRef.current,
            inFlightRuns: nextRuns,
          })
          const jobRequest = runTarget.kind === 'ssh'
            ? {
                connection: runTarget.connection,
                provider: target.id,
                workspaceKey: agentWorkspaceKey,
                prompt: effectivePrompt,
                sessionId: canResume ? session.sessionId : null,
                model: requestedModel,
                effort: requestedEffort,
              }
            : {
                provider: target.id,
                projectPath: runProject.path,
                workspaceKey: agentWorkspaceKey,
                prompt: effectivePrompt,
                attachments: attachments.map((attachment) => attachment.path),
                sessionId: canResume ? session.sessionId : null,
                model: requestedModel,
                effort: requestedEffort,
              }
          return ensyncHost.runChatJob(jobId, runTarget.kind, jobRequest, (event) => {
            if (event.type === 'started') providerProcessStarted = true
            if (event.type !== 'finished' && typeof event.sequence === 'number') {
              updateInFlightRun(chatId, (current) => current ? {
                ...current,
                providerProcessStarted: providerProcessStarted || current.providerProcessStarted,
                liveSteerReady: liveSteerReadyAfterEvent(current.liveSteerReady, event),
                lastEventSequence: Math.max(current.lastEventSequence ?? 0, event.sequence!),
              } : current)
            }
            appendChatExecutionEvent(chatId, event)
          }, runController.signal, {
            nativeWorkspaceId: isNativeWorkspaceIdentity(nativeWorkspaceIdentity)
              ? nativeWorkspaceIdentity.id
              : null,
            projectId: runProject.id,
            chatId,
            turnId,
            predecessorTranscriptFingerprint: predecessorFingerprint,
          })
        },
      )
    }

    let queueMayAdvance = false
    try {
      let result
      while (!result) {
        try {
          if (runController.signal.aborted) throw cancelledRunError()
          result = await run(routedProvider, providerPrompt)
        } catch (attemptError) {
          if (runWasCancelled(attemptError, runController.signal)) throw cancelledRunError()
          const proof = fallbackEnabled ? safeFallbackProof(attemptError) : null
          if (!proof) throw attemptError
          const fallback = await selectAutomaticFallbackProviderAfterRefresh(
            runExecutionProviders,
            runFallbackOrder,
            attemptedProviders,
            runTarget.kind === 'local'
              ? async () => {
                  const online = await refreshProviders(true)
                  if (!online) return null
                  runExecutionProviders = providersForTarget(providersRef.current, runTarget)
                  return runExecutionProviders
                }
              : undefined,
          )
          if (!fallback) throw attemptError
          const reason = proof.kind === 'quota'
            ? `${routedProvider.name} reported a Host-verified quota failure with zero observed activity; continuing with ${fallback.name}.`
            : `${routedProvider.name} failed Host preflight before execution; continuing with ${fallback.name}.`
          fallbackReason = appendFallbackReason(fallbackReason, reason)
          routedProvider = fallback
        }
      }
      if (runController.signal.aborted) throw cancelledRunError()
      chatRunCancellationRef.current.finish(chatId, runController)
      const continuityCapsuleUsed = runAutoContext || fallbackReason !== null || attemptedProviders.length > 1
      await completeChatRun({
        chatId,
        turnId,
        result,
        runTargetKey,
        projectPath: runProject.path,
        priorMessageCount: chatToSend.messages.length,
        continuityCapsuleUsed,
        attemptedProviders,
        fallbackReason,
        gitBefore: continuationGit(handoffGitStatus),
        gitReason: handoffGitStatusReason,
      })
      queueMayAdvance = true
    } catch (runError) {
      const failedAt = new Date().toISOString()
      if (runError instanceof ChatJobOccupiedError) {
        const owner = runError.owner as typeof runError.owner & { turnId?: string | null }
        const occupiedQueueSnapshot = occupiedQueueSnapshotForAttempt(queuedPrompt, {
          messageId: `msg-${turnId}`,
          enqueuedAt: failedAt,
          preferences: {
            providerMode: chatToSendCurrent.providerMode ?? 'auto',
            provider: routedProvider.id,
            sizeTier: chatToSendCurrent.sizeTier ?? null,
            automaticFallback: runAutoFallback,
            autoContextSkill: runAutoContext,
            fallbackProviderOrder: [...runFallbackOrder],
            executionTargetKey: runTargetKey,
            projectId: runProject.id,
            projectPath: runProject.path,
          },
        })
        const converted = convertPendingTurnToOccupiedQueue({
          chats: chatsRef.current,
          queues: promptQueuesRef.current,
          inFlightRuns: inFlightRunsRef.current,
          occupiedRuns: occupiedRunsRef.current,
          chatId,
          turnId,
          queueId: occupiedQueueSnapshot.queueId,
          messageId: occupiedQueueSnapshot.messageId,
          prompt: message,
          attachments,
          enqueuedAt: occupiedQueueSnapshot.enqueuedAt,
          preferences: occupiedQueueSnapshot.preferences,
          owner,
          binding: { projectId: runProject.id, projectPath: runProject.path, chatId },
        })
        if (converted.status !== 'invalid') {
          chatsRef.current = converted.chats
          promptQueuesRef.current = converted.queues
          inFlightRunsRef.current = converted.inFlightRuns as Record<string, PersistedInFlightRun>
          occupiedRunsRef.current = converted.occupiedRuns
          updateOccupiedShellReachability(chatId, converted.occupiedRuns[chatId]?.ownerJobId ?? '', false)
          setChats(converted.chats)
          setPromptQueues(converted.queues)
          setInFlightRuns(converted.inFlightRuns as Record<string, PersistedInFlightRun>)
          setOccupiedRuns(converted.occupiedRuns)
          const nextErrors = updateChatError(chatId, null)
          commitWorkspace({
            chats: converted.chats,
            promptQueues: converted.queues,
            inFlightRuns: converted.inFlightRuns as Record<string, PersistedInFlightRun>,
            occupiedRuns: converted.occupiedRuns,
            chatErrors: nextErrors,
          })

          return
        }
      }
      if (runWasCancelled(runError, runController.signal)) {
        const nextSessions = { ...chatSessionsRef.current }
        delete nextSessions[chatId]
        chatSessionsRef.current = nextSessions
        setChatSessions(nextSessions)
        const stoppedChats: Chat[] = chatsRef.current.map((chat): Chat => chat.id === chatId ? {
          ...chat,
          subtitle: 'Stopped by you',
          messages: chat.messages.map((messageItem) => messageItem.turnId === turnId && messageItem.role === 'user'
            ? { ...messageItem, deliveryStatus: 'cancelled' as const }
            : messageItem),
          continuation: {
            turnId,
            status: providerProcessStarted ? 'reconciliation_required' as const : 'cancelled' as const,
            termination: 'cancelled' as const,
            reconciliationRequired: providerProcessStarted,
            provider: routedProvider.id,
            model: null,
            sizeTier: chatToSend.sizeTier ?? null,
            executionTarget: runTargetKey,
            sessionResumable: false,
            attemptedProviders,
            fallbackReason,
            completedAt: failedAt,
            gitBefore: continuationGit(handoffGitStatus),
            gitAfter: null,
            gitReason: providerProcessStarted
              ? runTarget.kind === 'ssh'
                ? 'The SSH run was stopped after it began. Remote file or command activity may be partial and must be reconciled before retrying.'
                : 'The provider process was stopped after it began. File or command activity may be partial and must be reconciled before retrying.'
              : 'The run was stopped before Ensync Host reported that the provider process started.',
            semanticSummary: null,
          },
        } : chat)
        chatsRef.current = stoppedChats
        setChats(stoppedChats)
        updateChatError(chatId, null)
        return
      }
      if (runWasInterrupted(runError)) {
        markDetachedRunInterrupted(chatId, inFlightRunsRef.current[chatId] ?? {
          turnId,
          provider: routedProvider.id,
          sizeTier: chatToSend.sizeTier ?? null,
          executionTarget: runTargetKey,
          attemptedProviders,
          fallbackReason,
          providerProcessStarted,
          startedAt: runStartedAt,
          gitBefore: continuationGit(handoffGitStatus),
        })
        return
      }
      const failureMessage = runError instanceof Error ? runError.message : 'The Ensync Host run failed.'
      if (runError instanceof EnsyncHostError && runError.code === 'shared_checkout_dirty') {
        setGitWorkflowMode('manage')
      }
      const failedChats: Chat[] = chatsRef.current.map((chat): Chat => chat.id === chatId ? {
        ...chat,
        subtitle: 'Run failed',
        messages: chat.messages.map((messageItem) => messageItem.turnId === turnId && messageItem.role === 'user'
          ? { ...messageItem, deliveryStatus: 'failed' as const }
          : messageItem),
        continuation: runAutoContext || fallbackReason !== null || attemptedProviders.length > 1 ? {
          turnId,
          status: runNeedsReconciliation(runError) ? 'reconciliation_required' as const : 'blocked' as const,
          provider: routedProvider.id,
          model: null,
          sizeTier: chatToSend.sizeTier ?? null,
          executionTarget: runTargetKey,
          sessionResumable: false,
          attemptedProviders,
          fallbackReason: fallbackReason ?? failureMessage,
          completedAt: failedAt,
          gitBefore: continuationGit(handoffGitStatus),
          gitAfter: null,
          gitReason: handoffGitStatusReason || 'Git state after the failed run was not verified',
        } : chat.continuation,
      } : chat)
      chatsRef.current = failedChats
      setChats(failedChats)
      updateChatError(chatId, failureMessage)
      // The same Host proof that authorizes an automatic provider handoff is
      // what makes a one-click re-run honest: zero observed activity.
      if (safeFallbackProof(runError)) setVerifiedRetryableChatIds(withChatId(chatId))
    } finally {
      chatRunCancellationRef.current.finish(chatId, runController)
      chatRunRegistryRef.current.finish(chatId)
      delete activeTurnIdsRef.current[chatId]
      rememberCompletedNativeRun(chatId, inFlightRunsRef.current[chatId])
      const nextRuns = updateInFlightRun(chatId, () => undefined)
      commitWorkspace({
        chats: chatsRef.current,
        chatSessions: chatSessionsRef.current,
        chatErrors: chatErrorsRef.current,
        chatExecutionEvents: chatExecutionEventsRef.current,
        inFlightRuns: nextRuns,
        occupiedRuns: occupiedRunsRef.current,
      })
      setSendingChatIds(chatRunRegistryRef.current.snapshot())
      if (runTarget.kind === 'local') void refreshProviders(false)
      // Consume the arm unconditionally so it can never outlive its own run.
      const stopAndSendArmed = stopAndSendChatIdsRef.current.delete(chatId)
      if (queueMayAdvanceAfterRun({ completedSuccessfully: queueMayAdvance, stopAndSendArmed })) {
        queueMicrotask(() => void drainPromptQueue(chatId))
      }
    }
  }

  const handlePushQueuedNow = async (chatId: string) => {
    const entry = promptQueuesRef.current[chatId]?.[0]
    const activeRun = inFlightRunsRef.current[chatId]
    const chat = chatsRef.current.find((item) => item.id === chatId)
    const queuedMessage = chat?.messages.find((item) =>
      item.id === entry?.messageId && item.role === 'user' && item.deliveryStatus === 'queued')
    const exactActiveCodexTurn = entry
      && activeRun
      && entry.predecessorTurnId === activeRun.turnId
      && entry.preferences.executionTargetKey === activeRun.executionTarget
      && entry.preferences.projectId === activeRun.projectId
      && entry.preferences.projectPath === activeRun.projectPath
      && activeRun.provider === 'codex'
      && activeRun.executionTarget === 'local'
      && typeof activeRun.jobId === 'string'
      && Boolean(activeRun.jobId)
    if (!entry || !activeRun || !activeRun.jobId || !queuedMessage || !exactActiveCodexTurn) {
      updateChatError(chatId, 'This queued message can no longer be matched to the exact active local Codex turn. It remains safely queued.')
      return
    }
    if (steeringChatIdsRef.current.has(chatId)) return

    steeringChatIdsRef.current.add(chatId)
    setPushingQueuedChatIds((current) => new Set(current).add(chatId))
    try {
      await ensyncHost.steerChatJob(
        activeRun.jobId,
        messageTextWithAttachments(entry.prompt, entry.attachments),
        entry.id,
        normalizeFileAttachments(entry.attachments).map((attachment) => attachment.path),
      )

      const replyAlreadyVisible = chatsRef.current.some((currentChat) => currentChat.id === chatId
        && currentChat.messages.some((item) => item.role === 'agent' && item.turnId === activeRun.turnId))
      const nextChats = chatsRef.current.map((currentChat) => currentChat.id === chatId ? {
        ...currentChat,
        messages: promoteQueuedMessageToActiveTurn(
          currentChat.messages,
          entry.messageId,
          activeRun.turnId,
        ),
      } : currentChat)
      const nextQueues = promoteQueuedPromptToActiveTurn(
        promptQueuesRef.current,
        chatId,
        entry.id,
        activeRun.turnId,
      )
      chatsRef.current = nextChats
      setChats(nextChats)
      updatePromptQueues(nextQueues)

      let nextSessions = chatSessionsRef.current
      const session = chatSessionsRef.current[chatId]
      if (replyAlreadyVisible && session?.provider === 'codex' && typeof session.syncedMessageCount === 'number') {
        nextSessions = {
          ...chatSessionsRef.current,
          [chatId]: { ...session, syncedMessageCount: session.syncedMessageCount + 1 },
        }
        chatSessionsRef.current = nextSessions
        setChatSessions(nextSessions)
      }
      const nextErrors = updateChatError(chatId, null)
      commitWorkspace({
        chats: nextChats,
        promptQueues: nextQueues,
        chatSessions: nextSessions,
        chatErrors: nextErrors,
      })
    } catch (steerError) {
      const safelyNotDelivered = liveSteerWasSafelyRejected(steerError)
      if (safelyNotDelivered) {
        const rejectionMessage = steerError instanceof Error
          ? steerError.message
          : 'The active turn did not accept this message.'
        updateChatError(chatId, `${rejectionMessage} It remains queued.`)
      } else {
        // An unconfirmed live delivery must never execute later as a separate
        // queued turn, because that could duplicate project mutations.
        const nextQueues = removePromptFromQueue(promptQueuesRef.current, chatId, entry.id)
        const nextChats: Chat[] = chatsRef.current.map((currentChat): Chat => currentChat.id === chatId ? {
          ...currentChat,
          messages: currentChat.messages.map((item) => item.id === entry.messageId
            ? { ...item, deliveryStatus: 'interrupted' as const }
            : item),
        } : currentChat)
        chatsRef.current = nextChats
        setChats(nextChats)
        updatePromptQueues(nextQueues)
        const nextErrors = updateChatError(chatId, steerError instanceof Error
          ? `${steerError.message} The message was removed from automatic execution to prevent a duplicate.`
          : 'Ensync could not confirm live delivery. The message was removed from automatic execution to prevent a duplicate.')
        commitWorkspace({ chats: nextChats, promptQueues: nextQueues, chatErrors: nextErrors })
      }
    } finally {
      steeringChatIdsRef.current.delete(chatId)
      setPushingQueuedChatIds((current) => {
        const next = new Set(current)
        next.delete(chatId)
        return next
      })
    }
  }
  pushQueuedNowRef.current = handlePushQueuedNow

  const occupiedBinding = (owner: OccupiedRuns[string] | undefined) => owner ? {
    workspaceId: owner.nativeWorkspaceId ?? '',
    jobId: owner.ownerJobId,
    turnId: owner.turnId ?? '',
    provider: owner.provider,
    targetKind: owner.targetKind,
    projectId: owner.projectId,
    projectPath: owner.projectPath,
    chatId: owner.chatId,
  } : null

  const handleViewOccupiedRun = async (chatId: string) => {
    const owner = occupiedRunsRef.current[chatId]
    const entry = promptQueuesRef.current[chatId]?.[0]
    const binding = occupiedBinding(owner)
    const controls = occupiedRunControls(owner, entry, binding, {
      nativeAvailable: typeof window.ensyncDesktop?.focusWorkspace === 'function',
      shellReachable: Boolean(owner
        && occupiedShellReachabilityRef.current[chatId] === owner.ownerJobId),
    })
    if (!owner || !binding || !controls.canView || !owner.nativeWorkspaceId
      || typeof window.ensyncDesktop?.focusWorkspace !== 'function') {
      updateChatError(chatId, 'Ensync cannot verify the active run window. The message remains queued here.')
      return
    }
    try {
      const focused = await window.ensyncDesktop.focusWorkspace({
        workspaceId: owner.nativeWorkspaceId,
        projectId: owner.projectId,
        projectPath: owner.projectPath,
        chatId: owner.chatId,
        jobId: owner.ownerJobId,
      })
      updateChatError(chatId, focused
        ? null
        : 'The active run window is no longer available. The message remains queued here.')
    } catch {
      updateChatError(chatId, 'Ensync could not open the active run window. The message remains queued here.')
    }
  }

  const handleTransferToOccupiedRun = async (chatId: string, stopAndSend = false) => {
    const owner = occupiedRunsRef.current[chatId]
    const originalEntry = promptQueuesRef.current[chatId]?.[0]
    const binding = occupiedBinding(owner)
    const controls = occupiedRunControls(owner, originalEntry, binding, {
      nativeAvailable: typeof window.ensyncDesktop?.focusWorkspace === 'function',
      shellReachable: Boolean(owner
        && occupiedShellReachabilityRef.current[chatId] === owner.ownerJobId),
    })
    const bridge = window.ensyncDesktop
    const authorized = stopAndSend ? controls.canStopAndSend : controls.canPush
    if (!owner || !originalEntry || !binding || !owner.nativeWorkspaceId || !authorized
      || typeof bridge?.handoffQueuedMessage !== 'function') {
      updateChatError(chatId, 'The exact active run can no longer accept this handoff. The message remains safely queued.')
      return
    }
    if (transferringChatIdsRef.current.has(chatId)) return
    transferringChatIdsRef.current.add(chatId)
    setPushingQueuedChatIds((current) => new Set(current).add(chatId))

    const entry = handoffEntryForAction(originalEntry, stopAndSend, new Date().toISOString())
    if (!entry) {
      updateChatError(chatId, 'Ensync could not prepare the exact handoff. The source message remains unchanged and queued.')
      transferringChatIdsRef.current.delete(chatId)
      setPushingQueuedChatIds((current) => {
        const next = new Set(current)
        next.delete(chatId)
        return next
      })
      return
    }

    try {
      const result = await bridge.handoffQueuedMessage({
        handoffId: entry.id,
        target: {
          workspaceId: owner.nativeWorkspaceId,
          projectId: owner.projectId,
          projectPath: owner.projectPath,
          chatId: owner.chatId,
          jobId: owner.ownerJobId,
        },
        entry,
      })
      if (result.status !== 'accepted' || result.handoffId !== entry.id
        || result.messageId !== entry.messageId) {
        updateChatError(chatId, result.status === 'unavailable'
          ? 'The active window did not acknowledge the handoff. The message remains queued here.'
          : 'The active window rejected the handoff because its exact run changed. The message remains queued here.')
        return
      }

      const currentHead = promptQueuesRef.current[chatId]?.[0]
      if (!currentHead || currentHead.id !== originalEntry.id || currentHead.messageId !== originalEntry.messageId) {
        updateChatError(chatId, 'The local queue changed during handoff. No additional message was removed.')
        return
      }
      if (JSON.stringify(currentHead) !== JSON.stringify(originalEntry)) {
        updateChatError(chatId, 'The queued message changed during handoff. No local message was removed.')
        return
      }
      const nextQueues = removePromptFromQueue(promptQueuesRef.current, chatId, originalEntry.id)
      const nextChats = chatsRef.current.map((chat) => chat.id === chatId ? {
        ...chat,
        messages: markQueuedMessageTransferred(chat.messages, originalEntry.messageId),
      } : chat)
      const nextOccupied = { ...occupiedRunsRef.current }
      delete nextOccupied[chatId]
      chatsRef.current = nextChats
      promptQueuesRef.current = nextQueues
      occupiedRunsRef.current = nextOccupied
      updateOccupiedShellReachability(chatId, owner.ownerJobId, false)
      setChats(nextChats)
      setPromptQueues(nextQueues)
      setOccupiedRuns(nextOccupied)
      const nextErrors = updateChatError(chatId, null)
      commitWorkspace({
        chats: nextChats,
        promptQueues: nextQueues,
        occupiedRuns: nextOccupied,
        chatErrors: nextErrors,
      })
      if (typeof bridge.focusWorkspace === 'function') {
        try {
          const focused = await bridge.focusWorkspace({
            workspaceId: owner.nativeWorkspaceId,
            projectId: owner.projectId,
            projectPath: owner.projectPath,
            chatId: owner.chatId,
            jobId: owner.ownerJobId,
          })
          if (!focused) updateChatError(chatId, 'The message was transferred, but its active window could not be focused.')
        } catch {
          updateChatError(chatId, 'The message was transferred, but Ensync could not focus its active window.')
        }
      }
    } catch {
      updateChatError(chatId, 'Ensync could not hand this message to the active window. It remains queued here.')
    } finally {
      transferringChatIdsRef.current.delete(chatId)
      setPushingQueuedChatIds((current) => {
        const next = new Set(current)
        next.delete(chatId)
        return next
      })
    }
  }

  useEffect(() => window.ensyncDesktop?.onQueuedMessageHandoff?.((request) => {
    if (!isNativeWorkspaceIdentity(nativeWorkspaceIdentity)) return { status: 'rejected' as const }
    const typedRequest = request as { handoffId: string; target: NativeExactRunBinding; entry: QueuedPrompt }
    const project = projectsRef.current.find((candidate) => candidate.id === request.target.projectId
      && candidate.path === request.target.projectPath)
    const chat = chatsRef.current.find((candidate) => candidate.id === request.target.chatId
      && candidate.projectId === request.target.projectId)
    if (!project || !chat) return { status: 'rejected' as const }

    const entry = request.entry as QueuedPrompt
    const reconciliation = reconcileQueuedMessageHandoff(typedRequest, {
      workspaceId: nativeWorkspaceIdentity.id,
      projectId: project.id,
      projectPath: project.path,
      chatId: chat.id,
      chats: chatsRef.current,
      queues: promptQueuesRef.current,
    })
    if (reconciliation.status === 'conflict') return { status: 'rejected' as const }
    if (reconciliation.status === 'duplicate') {
      // A byte-identical queue copy or immutable consumed tombstone already
      // proves target ownership. ACK before ephemeral run checks and never
      // repeat Push/Stop; the target FIFO/gates own future execution.
      return { status: 'duplicate' as const }
    }

    const activeRun = inFlightRunsRef.current[chat.id]
    const activeAuthorized = Boolean(activeRun
      && chatRunRegistryRef.current.has(chat.id)
      && activeRun.projectId === project.id
      && activeRun.projectPath === project.path
      && validateQueuedMessageHandoff(typedRequest, {
        workspaceId: nativeWorkspaceIdentity.id,
        projectId: project.id,
        projectPath: project.path,
        chatId: chat.id,
        activeRun,
        queue: promptQueuesRef.current[chat.id] ?? [],
      }))
    const completedRun = completedNativeRunsRef.current.get(request.target.jobId)
    const terminalAuthorized = !activeAuthorized && validateTerminalQueuedMessageHandoff(typedRequest, {
      workspaceId: nativeWorkspaceIdentity.id,
      projectId: project.id,
      projectPath: project.path,
      chatId: chat.id,
      completedRun,
    })
    if (!activeAuthorized && !terminalAuthorized) return { status: 'rejected' as const }

    const stopAndSendApproved = Boolean(entry.resumeApprovedAt)
    let action: 'push' | 'stop' | null = null
    if (activeAuthorized && reconciliation.status === 'accepted' && activeRun) {
      const liveSteerAvailable = activeRun.liveSteerReady === true
        && activeRun.provider === 'codex'
        && activeRun.executionTarget === 'local'
      if (stopAndSendApproved) {
        if (activeRun.providerProcessStarted !== true
          || !queuedPromptCanStopAndSendNow(entry, activeRun, { liveSteerAvailable })) {
          return { status: 'rejected' as const }
        }
        action = 'stop'
      } else {
        if (!liveSteerAvailable) return { status: 'rejected' as const }
        action = 'push'
      }
    }

    if (reconciliation.status === 'accepted') {
      const committed = commitHandoffAcceptance(
        reconciliation,
        ({ chats, promptQueues }) => commitWorkspace({ chats, promptQueues }),
        (accepted) => {
          // Persistence is target-first: refs and render state move only after
          // the synchronous snapshot commit has succeeded.
          promptQueuesRef.current = accepted.queues
          chatsRef.current = accepted.chats
          setPromptQueues(accepted.queues)
          setChats(accepted.chats)
        },
      )
      if (!committed) return { status: 'rejected' as const }
    }

    const persistedHead = promptQueuesRef.current[chat.id]?.[0]
    if (action && persistedHead?.id === entry.id && !handoffActionsInvokedRef.current.has(entry.id)) {
      handoffActionsInvokedRef.current.add(entry.id)
      queueMicrotask(() => {
        if (action === 'stop') stopAndSendNowRef.current(chat.id)
        else void pushQueuedNowRef.current(chat.id)
      })
    }
    return { status: reconciliation.status === 'accepted' ? 'accepted' as const : 'duplicate' as const }
  }), [commitWorkspace, nativeWorkspaceIdentity])

  function drainPromptQueue(chatId: string) {
    if (chatRunRegistryRef.current.has(chatId)) return
    if (occupiedRunsRef.current[chatId]) return
    const entry = promptQueuesRef.current[chatId]?.[0]
    const chat = chatsRef.current.find((item) => item.id === chatId)
    if (!entry || !chat || queuedPromptGate(chat, entry).state !== 'ready') return
    const liveTarget = executionTargetRef.current
    if (targetKey(liveTarget) !== entry.preferences.executionTargetKey) {
      setChatErrors((current) => ({
        ...current,
        [chatId]: `Queue paused on its original ${entry.preferences.executionTargetKey} target. Reconnect that exact target; Ensync will not substitute the current computer.`,
      }))
      return
    }
    const project = projectsRef.current.find((item) => item.id === entry.preferences.projectId
      && item.path === entry.preferences.projectPath)
    if (!project?.verified) {
      setChatErrors((current) => ({
        ...current,
        [chatId]: 'Queue paused until Ensync Host re-verifies the exact project captured when this prompt was queued.',
      }))
      return
    }
    void handleSend(chatId, entry)
  }
  drainPromptQueueRef.current = drainPromptQueue

  const recoverDetachedRun = useCallback(async (chatId: string, initialRun: PersistedInFlightRun) => {
    if (!initialRun.jobId || recoveringChatIdsRef.current.has(chatId)) return
    if (!chatRunRegistryRef.current.begin(chatId)) return
    recoveringChatIdsRef.current.add(chatId)
    activeTurnIdsRef.current[chatId] = initialRun.turnId
    const runController = chatRunCancellationRef.current.begin(chatId)
    setSendingChatIds(chatRunRegistryRef.current.snapshot())
    let terminal = false
    let queueMayAdvance = false

    const waitToReconnect = () => new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 750)
      runController.signal.addEventListener('abort', () => {
        window.clearTimeout(timer)
        resolve()
      }, { once: true })
    })

    try {
      while (true) {
        if (runController.signal.aborted) {
          void ensyncHost.cancelChatJob(initialRun.jobId).catch(() => {})
          throw cancelledRunError()
        }
        try {
          const { job } = await ensyncHost.chatJob(initialRun.jobId)
          updateInFlightRun(chatId, (current) => current ? {
            ...current,
            providerProcessStarted: current.providerProcessStarted || job.providerProcessStarted,
            liveSteerReady: job.steerable,
          } : current)
          const cursor = inFlightRunsRef.current[chatId]?.lastEventSequence ?? 0
          const result = await ensyncHost.attachChatJob(initialRun.jobId, (event) => {
            if (event.type !== 'finished' && typeof event.sequence === 'number') {
              updateInFlightRun(chatId, (current) => current ? {
                ...current,
                providerProcessStarted: current.providerProcessStarted || event.type === 'started',
                liveSteerReady: liveSteerReadyAfterEvent(current.liveSteerReady, event),
                lastEventSequence: Math.max(current.lastEventSequence ?? 0, event.sequence!),
              } : current)
            }
            appendChatExecutionEvent(chatId, event)
          }, runController.signal, cursor)
          const run = inFlightRunsRef.current[chatId] ?? initialRun
          const chat = chatsRef.current.find((item) => item.id === chatId)
          await completeChatRun({
            chatId,
            turnId: run.turnId,
            result,
            runTargetKey: run.executionTarget,
            projectPath: run.projectPath ?? null,
            priorMessageCount: chat ? transcriptMessagesBeforeTurn(chat.messages, run.turnId).length : 0,
            continuityCapsuleUsed: run.continuityStateRequired === true,
            attemptedProviders: run.attemptedProviders,
            fallbackReason: run.fallbackReason,
            gitBefore: run.gitBefore,
            gitReason: run.gitReason ?? 'Git state before the detached run was not available',
          })
          terminal = true
          queueMayAdvance = true
          break
        } catch (error) {
          if (runWasCancelled(error, runController.signal)) {
            finishDetachedRunFailure(chatId, initialRun, error, true)
            terminal = true
            break
          }
          if (error instanceof EnsyncHostError && error.code === 'chat_job_not_found') {
            markDetachedRunInterrupted(chatId, inFlightRunsRef.current[chatId] ?? initialRun)
            terminal = true
            break
          }
          const reconnectableTransportFailure = !(error instanceof EnsyncHostError)
            || error.code === 'chat_job_stream_disconnected'
            || (error.code === null && error.status >= 500)
          if (reconnectableTransportFailure) {
            await waitToReconnect()
            continue
          }
          finishDetachedRunFailure(chatId, initialRun, error, false)
          terminal = true
          break
        }
      }
    } finally {
      chatRunCancellationRef.current.finish(chatId, runController)
      chatRunRegistryRef.current.finish(chatId)
      recoveringChatIdsRef.current.delete(chatId)
      delete activeTurnIdsRef.current[chatId]
      if (terminal) {
        rememberCompletedNativeRun(chatId, inFlightRunsRef.current[chatId] ?? initialRun)
        const nextRuns = updateInFlightRun(chatId, () => undefined)
        commitWorkspace({
          chats: chatsRef.current,
          chatSessions: chatSessionsRef.current,
          chatErrors: chatErrorsRef.current,
          chatExecutionEvents: chatExecutionEventsRef.current,
          inFlightRuns: nextRuns,
        })
      }
      setSendingChatIds(chatRunRegistryRef.current.snapshot())
      if (initialRun.executionTarget === 'local') void refreshProviders(false)
      const stopAndSendArmed = stopAndSendChatIdsRef.current.delete(chatId)
      if (queueMayAdvanceAfterRun({ completedSuccessfully: queueMayAdvance, stopAndSendArmed })) {
        queueMicrotask(() => void drainPromptQueueRef.current(chatId))
      }
    }
  }, [appendChatExecutionEvent, commitWorkspace, completeChatRun, finishDetachedRunFailure, markDetachedRunInterrupted, refreshProviders, rememberCompletedNativeRun, updateInFlightRun])
  recoverDetachedRunRef.current = (chatId, run) => { void recoverDetachedRun(chatId, run) }

  useEffect(() => {
    for (const [chatId, run] of Object.entries(inFlightRunsRef.current)) {
      if (run.jobId) void recoverDetachedRun(chatId, run)
    }
  }, [recoverDetachedRun])

  useEffect(() => {
    if (rediscoveredHostJobsRef.current || rediscoveringHostJobsRef.current) return
    const recoveryCandidateOptions = {
      maximumTurns: 12,
      excludedChatIds: Object.keys(occupiedRunsRef.current),
    }
    const candidates = runningHostJobCandidates(chatsRef.current, recoveryCandidateOptions)
      .filter((candidate) => !inFlightRunsRef.current[candidate.chatId]
        && !occupiedRunsRef.current[candidate.chatId])
    if (candidates.length === 0) {
      rediscoveredHostJobsRef.current = true
      return
    }

    let disposed = false
    rediscoveringHostJobsRef.current = true
    void (async () => {
      const inspected = await Promise.all(candidates.map(async (candidate) => {
        try {
          const { job } = await ensyncHost.chatJob(candidate.jobId)
          return { candidate, job, hostReached: true }
        } catch (error) {
          return {
            candidate,
            job: null,
            hostReached: error instanceof EnsyncHostError && error.status === 404,
          }
        }
      }))
      if (disposed) return

      const reconnectableByChat = new Map<string, (typeof inspected)[number]>()
      for (const item of inspected) {
        if (!item.job || !['running', 'completed'].includes(item.job.state)) continue
        const chat = chatsRef.current.find((candidate) => candidate.id === item.candidate.chatId)
        const exactTurnStillMissing = chat?.messages.some((message) => message.role === 'user'
          && message.turnId === item.candidate.turnId
          && ['pending', 'failed', 'interrupted'].includes(message.deliveryStatus ?? ''))
          && !chat.messages.some((message) => message.role === 'agent' && message.turnId === item.candidate.turnId)
        if (!exactTurnStillMissing) continue
        const current = reconnectableByChat.get(item.candidate.chatId)
        const preferItem = !current
          || (item.job.state === 'running' && current.job?.state !== 'running')
          || (item.job.state === current.job?.state
            && Date.parse(item.job.startedAt) > Date.parse(current.job?.startedAt ?? ''))
        if (preferItem) {
          reconnectableByChat.set(item.candidate.chatId, item)
        }
      }

      for (const { candidate, job } of reconnectableByChat.values()) {
        if (!job || inFlightRunsRef.current[candidate.chatId]
          || occupiedRunsRef.current[candidate.chatId]) continue
        const chat = chatsRef.current.find((item) => item.id === candidate.chatId)
        const project = projectsRef.current.find((item) => item.id === chat?.projectId)
        const exactExecutionTarget = job.kind === 'local'
          ? 'local'
          : executionTargetRef.current.kind === 'ssh'
            ? targetKey(executionTargetRef.current)
            : null
        if (!chat || !project?.path || exactExecutionTarget === null) continue

        const adopted = adoptReconnectableHostJobState({
          chats: chatsRef.current,
          chatErrors: chatErrorsRef.current,
          chatExecutionEvents: chatExecutionEventsRef.current,
          inFlightRuns: inFlightRunsRef.current,
        }, {
          candidate,
          job,
          projectPath: project.path,
          executionTarget: exactExecutionTarget,
        })
        if (!adopted) continue

        const nextChats = adopted.chats as Chat[]
        const nextErrors = adopted.chatErrors
        const nextEvents = adopted.chatExecutionEvents as Record<string, ChatExecutionEvent[]>
        const nextRuns = adopted.inFlightRuns as Record<string, PersistedInFlightRun>
        const recoveredRun = adopted.inFlightRun as PersistedInFlightRun
        if (occupiedRunsRef.current[candidate.chatId] || !commitWorkspace({
          chats: nextChats,
          chatErrors: nextErrors,
          chatExecutionEvents: nextEvents,
          inFlightRuns: nextRuns,
        })) continue
        chatsRef.current = nextChats
        chatErrorsRef.current = nextErrors
        chatExecutionEventsRef.current = nextEvents
        inFlightRunsRef.current = nextRuns
        setChats(nextChats)
        setChatErrors(nextErrors)
        setChatExecutionEvents(nextEvents)
        setInFlightRuns(nextRuns)
        void recoverDetachedRun(candidate.chatId, recoveredRun)
      }

      // A Host 404 proves that the exact candidate is absent. Transport/ownership
      // failures leave discovery eligible for the next healthy Host refresh.
      if (inspected.every((item) => item.hostReached)) {
        rediscoveredHostJobsRef.current = true
      } else if (hostJobRecoveryRetry < 8) {
        window.setTimeout(() => setHostJobRecoveryRetry((current) => current + 1), 750)
      }
    })().finally(() => {
      rediscoveringHostJobsRef.current = false
    })

    return () => { disposed = true }
  }, [commitWorkspace, hostJobRecoveryRetry, hostOnline, recoverDetachedRun])

  /**
   * Re-sends the exact instruction of a turn that failed without running
   * anything. It becomes a new turn: the failed attempt stays in the
   * transcript, where the run prompt already marks it context-only, so no
   * retained Host job ID is reused and nothing is replayed silently.
   */
  const handleRetryFailedTurn = (chatId: string) => {
    const chat = chatsRef.current.find((item) => item.id === chatId)
    const retry = retryableFailedTurn(chat?.messages ?? [])
    if (!retry) return
    setVerifiedRetryableChatIds(withoutChatId(chatId))
    draftsRef.current = { ...draftsRef.current, [chatId]: retry.prompt }
    setDrafts(draftsRef.current)
    draftAttachmentsRef.current = { ...draftAttachmentsRef.current, [chatId]: retry.attachments }
    setDraftAttachments(draftAttachmentsRef.current)
    updateChatError(chatId, null)
    void handleSend(chatId)
  }

  const handleResumeQueue = (chatId: string) => {
    updatePromptQueues(approveNextQueuedPrompt(promptQueuesRef.current, chatId, new Date().toISOString()))
    setChatErrors((current) => ({ ...current, [chatId]: null }))
    queueMicrotask(() => drainPromptQueue(chatId))
  }

  const reviewAgentUpdates = () => {
    acknowledgeAgentUpdate()
    setAgentUpdateNotice(null)
    setWizardOpen(true)
  }

  useEffect(() => {
    for (const chatId of Object.keys(promptQueuesRef.current)) {
      queueMicrotask(() => drainPromptQueueRef.current(chatId))
    }
  }, [chats, executionTarget, hostOnline, projects, providers])

  return (
    <div className="app-shell">
      <header className="titlebar" {...getSectionProps('titleBar')}>
        {decorativeTrafficLightsVisible(window.ensyncDesktop) && (
          <div className="traffic-lights" aria-hidden="true"><span /><span /><span /></div>
        )}
        <div className="wordmark"><span className="wordmark__mark" aria-hidden="true"><span /><span /></span><span>ensync</span></div>
        <button
          className={`project-switcher ${activeProject.id ? 'project-switcher--selected' : ''}`}
          style={{ '--project-color': activeProject.color } as React.CSSProperties}
          onClick={() => setProjectOpen(true)}
          title={activeProject.path || 'Select a project'}
        >
          <span className="project-switcher__mark" aria-hidden="true"><FolderGit2 size={13} /></span>
          <span className="project-switcher__name">{activeProject.name}</span>
          <ChevronDown size={13} />
        </button>
        <div className="titlebar__tools">
          <button className={`host-pill ${hostOnline ? '' : 'host-pill--offline'}`} onClick={() => setRemoteOpen(true)}><span /><Server size={13} /> {hostOnline ? (executionTarget.kind === 'ssh' ? executionTarget.connection.hostname : 'Local host') : 'Host offline'}</button>
          <button className="usage-pill" onClick={() => setUsageOpen(true)} title={activeProvider.usage === null ? activeProvider.usageReason : `${activeProvider.usage}% used`}><i style={{ '--usage': `${activeProvider.usage ?? 0}%` } as React.CSSProperties} /><span>{activeProvider.usage === null ? 'Usage —' : `${activeProvider.usage}% used`}</span></button>
          <button className="search-command" onClick={() => setCommandOpen(true)}><Search size={14} /><span>Search or jump to</span><kbd>Ctrl/⌘ K</kbd></button>
          <button
            className={`icon-button mobile-account account-activity ${accountSyncStatus.authenticated ? 'account-activity--connected' : ''}`}
            onClick={() => setSettingsOpen(true)}
            aria-label={accountSyncStatus.authenticated ? `Chat sync: ${accountSyncStatus.username}` : 'Account & chat sync'}
          >
            <UserRound size={18} />
          </button>
          <button
            className="icon-button mobile-menu"
            onClick={toggleConversationSidebar}
            aria-expanded={mobileNavOpen && visibility.conversationSidebar}
            aria-label={mobileNavOpen ? 'Hide conversations' : 'Show conversations'}
          >
            <Menu size={18} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <nav className="activity-bar" aria-label="Primary navigation" {...getSectionProps('activityRail')}>
          <div>
            <button
              className="activity-button activity-button--active"
              type="button"
              title="Chats"
              aria-current="page"
              aria-expanded={visibility.conversationSidebar}
              aria-label={visibility.conversationSidebar ? 'Hide conversations' : 'Show conversations'}
              onClick={toggleConversationSidebar}
            >
              <MessageSquareText size={20} />
            </button>
            <button
              className={`activity-button ${agentUpdateReminderDue ? 'agent-update-activity--due' : ''}`}
              title={agentUpdateReminderDue ? 'Agent update reminder' : 'Agent connections'}
              aria-label={agentUpdateReminderDue ? 'Agent connections, update review due' : 'Agent connections'}
              onClick={() => {
                if (agentUpdateReminderDue) acknowledgeAgentUpdate()
                setWizardOpen(true)
              }}
            ><Bot size={20} /></button>
            <button className="activity-button" title="Project memory" onClick={() => setContextOpen(true)}><Layers3 size={20} /></button>
            <button className="activity-button" title="Remote runtime" onClick={() => setRemoteOpen(true)}><Server size={20} /></button>
          </div>
          <div>
            <button className="activity-button" title="Help desk" onClick={() => setSupportOpen(true)}><LifeBuoy size={19} /></button>
            <button className={`activity-button account-activity ${accountSyncStatus.authenticated ? 'account-activity--connected' : ''}`} title={accountSyncStatus.authenticated ? `Chat sync: ${accountSyncStatus.username}` : 'Account & chat sync'} onClick={() => setSettingsOpen(true)}><UserRound size={19} /></button>
            <button className="activity-button" title="Settings" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button>
          </div>
        </nav>

        <ResizableSidebar
          className={`sidebar ${mobileNavOpen ? 'sidebar--mobile-open' : ''}`}
          bodyClassName="sidebar__body"
          width={conversationSidebarWidth}
          storageKey={sidebarStorageKey}
          showRestoreControl={false}
          visible={visibility.conversationSidebar}
          onWidthChange={setConversationSidebarWidth}
          onVisibilityChange={(visible) => {
            setVisible('conversationSidebar', visible)
            if (!visible) setMobileNavOpen(false)
          }}
          headerActions={<><button className="icon-button" title="New conversation" onClick={() => createChat()}><Plus size={17} /></button><button className="icon-button close-mobile" onClick={() => setMobileNavOpen(false)}><X size={17} /></button></>}
        >
          <div className="sidebar-search"><Search size={14} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations" /></div>
          <div className="chat-history">
            {groupedChats.map(({ group, chats: groupChats }) => groupChats.length > 0 && (
              <section className="history-group" key={group}>
                <div className="history-group__label">{group}</div>
                {groupChats.map((chat) => {
                  const provider = providerForChat(executionProviders, chat, fallbackProviderOrder, inFlightRuns[chat.id])
                  return (
                    <button className={`history-item ${activeChat?.id === chat.id ? 'history-item--active' : ''}`} key={chat.id} onClick={() => openChat(chat.id)}>
                      <ProviderMark provider={provider} small />
                      <span className="history-item__copy"><strong dir="auto">{chat.title}</strong><small dir="auto">{chat.subtitle}</small></span>
                      {chat.pinned && <span className="pin">•</span>}
                    </button>
                  )
                })}
              </section>
            ))}
            {groupedChats.every((group) => group.chats.length === 0) && <div className="no-results">No conversations found.</div>}
          </div>
          <div className="sidebar__footer">
            <button onClick={() => setContextOpen(true)}>
              <span className="sync-icon project-context-icon" style={{ '--project-color': activeProject.color } as React.CSSProperties}><FileText size={14} /></span>
              <span><strong>Project context</strong><small>{activeProject.verified ? `${activeProject.context.files.length} .relay files found` : 'Not verified by Ensync Host'}</small></span>
              <ChevronRight size={14} />
            </button>
          </div>
        </ResizableSidebar>
        {mobileNavOpen && <button className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}

        <main className="main-area">
          <SplitWorkspace
            tabs={projectTabs}
            chats={displayProjectChats}
            providers={executionProviders}
            completedTabIds={completedTabIds}
            completionIndicator={completionIndicator}
            activeTabId={activeTabId}
            onActiveTabChange={activateTab}
            onTabReorder={reorderTab}
            onCloseTab={closeTab}
            onNewTab={createChat}
            onFilesDrop={handleFilesDrop}
            fileDropAvailable={executionTarget.kind === 'local' && typeof window.ensyncDesktop?.getPathForFile === 'function'}
            fileDropUnavailableMessage={executionTarget.kind === 'ssh'
              ? 'Switch to the local Ensync Host to attach files'
              : 'Local file drops need the native Ensync app'}
            viewMode={conversationLayout}
            showTabHeaders={visibility.tabStrip}
            storageKey={splitLayoutStorageKey}
            defaultLayout={splitLayout}
            onLayoutChange={setSplitLayout}
            emptyState={(
              <>
                <p>No conversations open.</p>
                <button type="button" onClick={() => createChat()}><Plus size={15} /> New conversation</button>
              </>
            )}
            renderPane={({ chat, isActive }) => {
              const occupied = occupiedRuns[chat.id]
              const occupiedHead = promptQueues[chat.id]?.[0]
              const occupiedControls = occupiedRunControls(
                occupied,
                occupiedHead,
                occupiedBinding(occupied),
                {
                  nativeAvailable: typeof window.ensyncDesktop?.focusWorkspace === 'function',
                  shellReachable: Boolean(occupied
                    && occupiedShellReachability[chat.id] === occupied.ownerJobId),
                },
              )
              const nativeIdentityAvailable = isNativeWorkspaceIdentity(nativeWorkspaceIdentity)
              const nativeFocusAvailable = typeof window.ensyncDesktop?.focusWorkspace === 'function'
              const nativeHandoffAvailable = typeof window.ensyncDesktop?.handoffQueuedMessage === 'function'
              const occupiedReason = !occupied
                ? null
                : !nativeIdentityAvailable
                  ? 'This browser cannot open or control another Ensync window. The message remains queued.'
                  : !nativeFocusAvailable || !nativeHandoffAvailable
                    ? 'This Ensync window is missing the active-run bridge. Quit Ensync completely and reopen it; the message remains queued.'
                    : !occupied.turnId
                      ? 'The active run belongs to another Ensync Host, so this window cannot control it. The message remains queued.'
                      : occupiedControls.reason
              const localActiveRun = inFlightRuns[chat.id]
              const localCanPush = Boolean(
                sendingChatIds.has(chat.id)
                && localActiveRun?.liveSteerReady === true
                && localActiveRun?.provider === 'codex'
                && localActiveRun.executionTarget === 'local'
                && localActiveRun.jobId
                && occupiedHead
                && occupiedHead.predecessorTurnId === localActiveRun.turnId
                && occupiedHead.preferences.executionTargetKey === localActiveRun.executionTarget
                && occupiedHead.preferences.projectId === localActiveRun.projectId
                && occupiedHead.preferences.projectPath === localActiveRun.projectPath,
              )
              const localCanStopAndSend = Boolean(
                sendingChatIds.has(chat.id)
                && queuedPromptCanStopAndSendNow(occupiedHead, localActiveRun, {
                  liveSteerAvailable: localActiveRun?.liveSteerReady === true && localActiveRun.provider === 'codex',
                }),
              )
              const activeProviderId = localActiveRun?.provider ?? occupied?.provider
              const activeRunProviderName = activeProviderId
                ? executionProviders.find((candidate) => candidate.id === activeProviderId)?.name ?? activeProviderId
                : null
              const owningConversation = owningConversationTargets[chat.id] ?? null
              return (
              <ConversationPane
                chat={chat}
                isActive={isActive}
                onOpenFile={setViewedFilePath}
                provider={providerForChat(executionProviders, chat, fallbackProviderOrder, inFlightRuns[chat.id])}
                autoProvider={automaticProvider(executionProviders, fallbackProviderOrder, chat.provider)}
                runningProviderPinned={runPinsDisplayedProvider(executionProviders, inFlightRuns[chat.id])}
                providers={executionProviders}
                projectPath={executionTarget.kind === 'ssh' ? `${executionTarget.connection.username}@${executionTarget.connection.hostname}:${executionTarget.connection.projectPath}` : activeProject.path}
                projectContextAvailable={activeProject.verified && activeProject.context.files.length > 0}
                draft={drafts[chat.id] ?? ''}
                attachments={draftAttachments[chat.id] ?? []}
                attachmentError={attachmentErrors[chat.id] ?? null}
                sending={sendingChatIds.has(chat.id)}
                liveSteering={
                  sendingChatIds.has(chat.id)
                  && Boolean(inFlightRuns[chat.id]?.liveSteerReady)
                  && executionTarget.kind === 'local'
                  && inFlightRuns[chat.id]?.provider === 'codex'
                  && inFlightRuns[chat.id]?.executionTarget === 'local'
                  && Boolean(inFlightRuns[chat.id]?.jobId)
                  && (promptQueues[chat.id]?.length ?? 0) === 0
                }
                canPushQueuedNow={localCanPush || (occupiedControls.canPush && nativeHandoffAvailable)}
                canStopAndSendNow={localCanStopAndSend || (occupiedControls.canStopAndSend && nativeHandoffAvailable)}
                canViewOccupiedRun={occupiedControls.canView && nativeFocusAvailable}
                occupiedRunReason={occupiedReason}
                liveDeliverySupported={(() => {
                  // With no active run there is no provider limit to report; keep the plain copy.
                  if (localActiveRun) {
                    return localActiveRun.provider === 'codex' && localActiveRun.executionTarget === 'local'
                  }
                  if (occupied) return occupied.provider === 'codex' && occupied.targetKind === 'local'
                  return true
                })()}
                activeRunProviderName={activeRunProviderName}
                pushingQueued={pushingQueuedChatIds.has(chat.id)}
                runStartedAt={localActiveRun?.startedAt ?? occupied?.startedAt ?? null}
                occupiedRun={occupied ?? null}
                queuedPrompts={promptQueues[chat.id] ?? []}
                error={chatErrors[chat.id] ?? null}
                retryVerified={verifiedRetryableChatIds.has(chat.id)}
                providerMenuOpen={providerMenuChatId === chat.id}
                modelMenuOpen={modelMenuChatId === chat.id}
                autoFallback={autoFallback}
                autoContextSkill={autoContextSkill}
                fallbackProviders={fallbackProviders}
                executionEvents={chatExecutionEvents[chat.id] ?? []}
                owningConversation={owningConversation}
                executionPanelOpen={executionPanelOpenForChat(executionPanelOpenByChat, chat.id)}
                onAnswerQuestion={(answer) => handleAnswerQuestion(chat.id, answer)}
                onDraftChange={(value) => setDrafts((current) => ({ ...current, [chat.id]: value }))}
                onAttachmentRemove={(path) => setDraftAttachments((current) => ({
                  ...current,
                  [chat.id]: (current[chat.id] ?? []).filter((attachment) => attachment.path !== path),
                }))}
                onSend={() => handleSend(chat.id)}
                onStop={() => handleStop(chat.id)}
                onResumeQueue={() => handleResumeQueue(chat.id)}
                onRetryFailedTurn={() => handleRetryFailedTurn(chat.id)}
                onViewOccupiedRun={() => void handleViewOccupiedRun(chat.id)}
                onPushQueuedNow={() => occupied
                  ? void handleTransferToOccupiedRun(chat.id, false)
                  : void handlePushQueuedNow(chat.id)}
                onStopAndSendNow={() => occupied
                  ? void handleTransferToOccupiedRun(chat.id, true)
                  : handleStopAndSendNow(chat.id)}
                onProviderMenu={() => {
                  setModelMenuChatId(null)
                  setProviderMenuChatId((current) => current === chat.id ? null : chat.id)
                }}
                onModelMenu={() => {
                  setProviderMenuChatId(null)
                  setModelMenuChatId((current) => current === chat.id ? null : chat.id)
                }}
                onProviderAuto={() => setChatAutoProvider(chat.id)}
                onProviderChange={(providerId) => setChatProvider(chat.id, providerId)}
                onSizeTierChange={(sizeTier) => setChatSizeTier(chat.id, sizeTier)}
                onConnect={() => { setProviderMenuChatId(null); setModelMenuChatId(null); setWizardOpen(true) }}
                filePickerAvailable={executionTarget.kind === 'local' && typeof window.ensyncDesktop?.chooseChatFiles === 'function'}
                filePickerUnavailableMessage={executionTarget.kind === 'ssh'
                  ? 'Switch to the local Ensync Host to attach files'
                  : 'File selection needs the native Ensync app'}
                onFilesChoose={() => void handleFilesChoose(chat.id)}
                onContext={() => setContextOpen(true)}
                onAutoContextSkillChange={() => setAutoContextSkillEnabled(!autoContextSkill)}
                onExecutionPanelOpenChange={(open) => setExecutionPanelOpenByChat((current) =>
                  setExecutionPanelOpenForChat(current, chat.id, open),
                )}
                onOpenOwningConversation={async (target) => {
                  if (isNativeWorkspaceIdentity(nativeWorkspaceIdentity)
                    && target.workspaceId === nativeWorkspaceIdentity.id) {
                    const targetChat = chatsRef.current.find((candidate) => candidate.id === target.chatId
                      && candidate.projectId === target.projectId)
                    const targetProject = projectsRef.current.find((candidate) => candidate.id === target.projectId
                      && nativeProjectPathKey(candidate.path) === nativeProjectPathKey(target.projectPath))
                    if (!targetChat || !targetProject || !exactNativeChatFocusCanApply(target, {
                      workspaceId: nativeWorkspaceIdentity.id,
                      projectId: targetProject.id,
                      projectPath: targetProject.path,
                      chatId: targetChat.id,
                    })) return false
                    setProjects((current) => [targetProject, ...current.filter((candidate) => candidate.id !== targetProject.id)])
                    setActiveProjectId(targetProject.id)
                    openChatRef.current(targetChat.id)
                    setProjectError(null)
                    return true
                  }
                  if (typeof window.ensyncDesktop?.focusWorkspace !== 'function') return false
                  try {
                    return await window.ensyncDesktop.focusWorkspace(target)
                  } catch (error) {
                    console.error('[ensync-owning-conversation-focus]', error)
                    return false
                  }
                }}
                onSettings={() => setSettingsOpen(true)}
              />
              )
            }}
          />
        </main>
      </div>

      {agentUpdateReminderDue && !settingsOpen && !wizardOpen && (
        <div className="agent-update-reminder" role="status">
          <span><Bell size={17} /></span>
          <div><strong>Weekly agent update review</strong><p>Review all {installedAgentProviders.length} installed {installedAgentProviders.length === 1 ? 'provider' : 'providers'}. Ensync runs only verified native updater commands and otherwise uses the provider's own updater or official guide.</p></div>
          <button type="button" className="button button--primary" onClick={reviewAgentUpdates}>Review agents</button>
          <button type="button" className="button button--ghost" onClick={acknowledgeAgentUpdate}>Later</button>
        </div>
      )}
      {!agentUpdateReminderDue && agentUpdateNotice && !settingsOpen && !wizardOpen && (
        <div className={`agent-update-reminder agent-update-reminder--${agentUpdateNotice.tone}`} role={agentUpdateNotice.tone === 'error' ? 'alert' : 'status'}>
          <span>{agentUpdateNotice.tone === 'success' ? <CheckCircle2 size={17} /> : <CircleHelp size={17} />}</span>
          <div><strong>{agentUpdateNotice.tone === 'success' ? 'Agent update cycle started' : 'Agent update needs attention'}</strong><p>{agentUpdateNotice.message}</p></div>
          <button type="button" className="icon-button" aria-label="Dismiss agent update message" onClick={() => setAgentUpdateNotice(null)}><X size={16} /></button>
        </div>
      )}

      {wizardOpen && <ConnectionWizard providers={providers} hostOnline={hostOnline} hostError={hostError} hasActiveRuns={Object.keys(inFlightRuns).length > 0} onRefresh={refreshProviders} onUpdateStarted={recordAgentMaintenance} onClose={() => setWizardOpen(false)} />}
      {settingsOpen && <SettingsModal providers={executionProviders} placement={placement} setPlacement={setPlacement} conversationLayout={conversationLayout} setConversationLayout={setConversationLayout} autoFallback={autoFallback} setAutoFallback={setAutoFallback} autoContextSkill={autoContextSkill} setAutoContextSkill={setAutoContextSkillEnabled} fallbackProviderOrder={fallbackProviderOrder} setFallbackProviderOrder={updateFallbackProviderOrder} agentUpdatePreferences={agentUpdatePreferences} setAgentUpdateMode={setAgentUpdateMode} installedAgentProviders={installedAgentProviders} onReviewAgentUpdates={() => { setSettingsOpen(false); reviewAgentUpdates() }} accountSyncStatus={accountSyncStatus} accountSyncPhase={accountSyncPhase} accountSyncMessage={accountSyncMessage} syncedChatCount={chats.length} onAccountAuthenticate={authenticateAccountSync} onAccountLogout={logoutAccountSync} onAccountSync={synchronizeAccountWorkspace} onClose={() => setSettingsOpen(false)} />}
      {contextOpen && <ContextModal project={activeProject} onClose={() => setContextOpen(false)} />}
      {viewedFilePath && <FileViewerModal path={viewedFilePath} onClose={() => setViewedFilePath(null)} />}
      {projectOpen && <ProjectSwitcher projects={recentProjectOptions} activeProject={activeProject} hostError={projectError} onInspect={inspectAndFocusProject} onOpenGit={(mode) => { setProjectOpen(false); setGitWorkflowMode(mode) }} onOpenRemote={() => { setProjectOpen(false); setRemoteInitialRuntime('remote'); setRemoteOpen(true) }} onClose={() => setProjectOpen(false)} />}
      {gitWorkflowMode && <GitWorkflowModal mode={gitWorkflowMode} project={activeProject.verified ? activeProject : null} onImported={(project) => { focusProject(verifiedProject(project)); setGitWorkflowMode(null) }} onClose={() => setGitWorkflowMode(null)} />}
      {remoteOpen && <RemoteRuntimeModal hostOnline={hostOnline} providers={providers} project={activeProject} chat={activeChat ?? null} executionTarget={executionTarget} initialRuntime={remoteInitialRuntime} fallbackProviderOrder={fallbackProviderOrder} onExecutionTargetChange={setExecutionTarget} onClose={() => { setRemoteOpen(false); setRemoteInitialRuntime('local') }} />}
      {usageOpen && <UsageDashboard providers={executionProviders} modelTelemetry={modelTelemetry} hostOnline={hostOnline} onRefresh={refreshProviders} autoFallback={autoFallback} fallbackProviderOrder={fallbackProviderOrder} onClose={() => setUsageOpen(false)} />}
      {supportOpen && <div className="modal-backdrop support-backdrop" onMouseDown={() => setSupportOpen(false)}><div className="support-modal-shell" onMouseDown={(event) => event.stopPropagation()}><SupportDesk
        aiRepair={{
          available: supportRepairAvailable,
          providerName: supportRepairAvailable ? supportProvider.name : undefined,
          reason: executionTarget.kind !== 'local'
            ? 'AI repair currently requires the local Ensync Host; SSH repair is not enabled.'
            : !activeProject.verified
              ? 'Select and verify a local project before starting a repair.'
              : 'Connect Codex or Claude with available subscription usage before starting a repair.',
        }}
        onStartAiRepair={startSupportRepair}
        onClose={() => setSupportOpen(false)}
      /></div></div>}
      {commandOpen && <CommandPalette chats={projectChats} onOpenChat={(id) => { openChat(id); setCommandOpen(false) }} onNew={() => { createChat(); setCommandOpen(false) }} onSettings={() => { setSettingsOpen(true); setCommandOpen(false) }} onClose={() => setCommandOpen(false)} />}
    </div>
  )
}

function ConversationPane({
  chat,
  isActive,
  provider,
  autoProvider,
  runningProviderPinned,
  providers,
  projectPath,
  projectContextAvailable,
  draft,
  attachments,
  attachmentError,
  sending,
  liveSteering,
  canPushQueuedNow,
  canStopAndSendNow,
  canViewOccupiedRun,
  occupiedRunReason,
  liveDeliverySupported,
  activeRunProviderName,
  pushingQueued,
  runStartedAt,
  occupiedRun,
  queuedPrompts,
  error,
  retryVerified,
  providerMenuOpen,
  modelMenuOpen,
  autoFallback,
  autoContextSkill,
  fallbackProviders,
  executionEvents,
  owningConversation,
  executionPanelOpen,
  onAnswerQuestion,
  onDraftChange,
  onAttachmentRemove,
  onSend,
  onStop,
  onResumeQueue,
  onRetryFailedTurn,
  onViewOccupiedRun,
  onPushQueuedNow,
  onStopAndSendNow,
  onProviderMenu,
  onModelMenu,
  onProviderAuto,
  onProviderChange,
  onSizeTierChange,
  onConnect,
  filePickerAvailable,
  filePickerUnavailableMessage,
  onFilesChoose,
  onContext,
  onAutoContextSkillChange,
  onExecutionPanelOpenChange,
  onOpenOwningConversation,
  onSettings,
  onOpenFile,
}: {
  chat: Chat
  isActive: boolean
  /** Provider this conversation is actually on: the running turn, else its last verified turn. */
  provider: Provider
  /** Provider Auto would choose for the next turn from current verified usage. */
  autoProvider: Provider
  /** True while a Host-owned run pins `provider` to the executing turn. */
  runningProviderPinned: boolean
  providers: Provider[]
  projectPath: string
  projectContextAvailable: boolean
  draft: string
  attachments: FileAttachment[]
  attachmentError: string | null
  sending: boolean
  liveSteering: boolean
  canPushQueuedNow: boolean
  canStopAndSendNow: boolean
  canViewOccupiedRun: boolean
  occupiedRunReason: string | null
  liveDeliverySupported: boolean
  activeRunProviderName: string | null
  pushingQueued: boolean
  runStartedAt: string | null
  occupiedRun: OccupiedRuns[string] | null
  queuedPrompts: QueuedPrompt[]
  error: string | null
  retryVerified: boolean
  providerMenuOpen: boolean
  modelMenuOpen: boolean
  autoFallback: boolean
  autoContextSkill: boolean
  fallbackProviders: Provider[]
  executionEvents: ChatExecutionEvent[]
  owningConversation: ReferencedOwningConversation | null
  executionPanelOpen: boolean
  onAnswerQuestion: (answer: ProviderQuestionAnswerPayload | { questionId: string; cancelled: true }) => Promise<void>
  onDraftChange: (value: string) => void
  onAttachmentRemove: (path: string) => void
  onSend: () => void
  onStop: () => void
  onResumeQueue: () => void
  onRetryFailedTurn: () => void
  onViewOccupiedRun: () => void
  onPushQueuedNow: () => void
  onStopAndSendNow: () => void
  onProviderMenu: () => void
  onModelMenu: () => void
  onProviderAuto: () => void
  onProviderChange: (providerId: ProviderId) => void
  onSizeTierChange: (sizeTier: ModelSizeTier | null) => void
  onConnect: () => void
  filePickerAvailable: boolean
  filePickerUnavailableMessage: string
  onFilesChoose: () => void
  onContext: () => void
  onAutoContextSkillChange: () => void
  onExecutionPanelOpenChange: (open: boolean) => void
  onOpenOwningConversation: (target: ReferencedOwningConversation) => Promise<boolean>
  onSettings: () => void
  onOpenFile: (path: string) => void
}) {
  const { getSectionProps, isVisible, setVisible } = useUIVisibility()
  const providerButtonRef = useRef<HTMLButtonElement>(null)
  const providerMenuRef = useRef<HTMLDivElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const providerMenuId = `provider-menu-${chat.id}`
  const modelMenuId = `model-menu-${chat.id}`
  const providerMenuStyle = useFloatingMenuPosition(providerMenuOpen, providerButtonRef)
  const modelMenuStyle = useFloatingMenuPosition(modelMenuOpen, modelButtonRef)
  const elapsedWorkingLabel = useWorkingElapsedLabel(sending, runStartedAt)
  const occupiedElapsedLabel = useWorkingElapsedLabel(Boolean(occupiedRun), occupiedRun?.startedAt ?? null)
  // Offered only while Ensync still holds the Host's proof that this attempt
  // ran nothing, so a re-run can never duplicate half-applied project work.
  // Retrying restores the failed instruction into the composer, so it stays out
  // of the way of anything already written there.
  const retryableTurn = !sending && retryVerified && !draft.trim() && attachments.length === 0
    ? retryableFailedTurn(chat.messages)
    : null
  const canRunSelectedProvider = provider.connected && supportsChat(provider)
  const canRunFallback = autoFallback
    && chat.providerMode === 'fixed'
    && fallbackProviders.some((candidate) => candidate.id !== provider.id)
  const canRunChat = canRunSelectedProvider || canRunFallback
  const queueGate = queuedPromptGate(chat, queuedPrompts[0])
  const queueStatus = promptQueueStatusPresentation(queueGate, queuedPrompts.length, {
    liveDeliverySupported,
    activeProviderName: activeRunProviderName,
    stopAndSendAvailable: canStopAndSendNow,
  })
  // Live delivery is Codex-only; every other provider gets the honest
  // stop-then-run path rather than a silently missing control. Stopping a turn
  // discards its in-progress work, so the destructive action is deliberately
  // two-step and disarms itself rather than waiting silently.
  const [stopAndSendArmed, setStopAndSendArmed] = useState(false)
  useEffect(() => {
    if (!canStopAndSendNow && stopAndSendArmed) setStopAndSendArmed(false)
  }, [canStopAndSendNow, stopAndSendArmed])
  useEffect(() => {
    if (!stopAndSendArmed) return
    const timer = window.setTimeout(() => setStopAndSendArmed(false), 6000)
    return () => window.clearTimeout(timer)
  }, [stopAndSendArmed])
  const composerQueueState = promptQueueComposerState({
    sending,
    liveSteering,
    draft: draft || (attachments.length > 0 ? 'attached files' : ''),
    canRun: canRunChat,
  })
  const providerNotes = executionEvents
    .filter((event): event is Extract<ChatExecutionEvent, { type: 'note' }> => event.type === 'note')
    .slice(-6)
  // Derived from the same replayed event buffer the panel reads, so a window
  // that reconnects mid-turn still sees the question the provider is blocked on.
  const pendingQuestion = pendingQuestionsFromEvents(executionEvents)[0] ?? null
  const questionMessageProvider = providers.find((item) => item.id === pendingQuestion?.provider) ?? provider
  const [answeringQuestionId, setAnsweringQuestionId] = useState<string | null>(null)
  const [questionError, setQuestionError] = useState<string | null>(null)
  const submitQuestionAnswer = useCallback(async (
    answer: ProviderQuestionAnswerPayload | { questionId: string; cancelled: true },
  ) => {
    setAnsweringQuestionId(answer.questionId)
    setQuestionError(null)
    try {
      await onAnswerQuestion(answer)
    } catch (error) {
      setQuestionError(error instanceof Error ? error.message : 'Ensync Host could not deliver that answer.')
    } finally {
      setAnsweringQuestionId(null)
    }
  }, [onAnswerQuestion])
  const scrollContentRevision = useMemo(() => chatAutoScrollContentRevision({
    messages: chat.messages,
    executionEvents,
    sending,
    queuedPrompts,
    error,
  }), [chat.messages, error, executionEvents, queuedPrompts, sending])
  const {
    viewportRef: messageScrollRef,
    contentRef: messageColumnRef,
    pendingLatest,
    onScroll: onMessageScroll,
    jumpToLatest,
  } = useChatAutoScroll({
    chatId: chat.id,
    isActive,
    contentRevision: scrollContentRevision,
  })

  useLayoutEffect(() => {
    const textarea = composerRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const styles = window.getComputedStyle(textarea)
    const minHeight = Number.parseFloat(styles.minHeight) || 54
    const maxHeight = Number.parseFloat(styles.maxHeight) || 150
    const height = Math.max(minHeight, Math.min(maxHeight, textarea.scrollHeight))
    textarea.style.height = `${height}px`
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [draft])

  useEffect(() => {
    if (!providerMenuOpen && !modelMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (
        providerButtonRef.current?.contains(target)
        || providerMenuRef.current?.contains(target)
        || modelButtonRef.current?.contains(target)
        || modelMenuRef.current?.contains(target)
      )) return
      if (providerMenuOpen) onProviderMenu()
      if (modelMenuOpen) onModelMenu()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (providerMenuOpen) {
        onProviderMenu()
        providerButtonRef.current?.focus()
      }
      if (modelMenuOpen) {
        onModelMenu()
        modelButtonRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [modelMenuOpen, onModelMenu, onProviderMenu, providerMenuOpen])

  const automaticMode = chat.providerMode !== 'fixed'
  const providerPickerMode = automaticMode ? 'Provider · Auto' : 'Provider · Fixed'
  // The face of this control is a fact, so say which fact it is. Idle Auto names
  // the provider the next turn would actually run on; the names only differ when
  // automatic routing has no candidate and the last verified turn is all we know.
  const providerPickerTitle = runningProviderPinned
    ? `${provider.name} is running this turn.`
    : automaticMode
      ? provider.id === autoProvider.id
        ? `Auto would run the next turn on ${provider.name}.`
        : `${provider.name} ran this conversation's last turn. No connected provider reports verified remaining subscription usage right now.`
      : `This conversation is fixed to ${provider.name}.`
  const selectedSize = MODEL_SIZE_OPTIONS.find((option) => option.tier === chat.sizeTier) ?? null
  const modelPickerDisabled = !supportsChat(provider)
  const modelPickerLabel = selectedSize?.label ?? 'Provider default'
  const modelPickerContext = selectedSize ? 'Model size' : 'Model size · Provider default'
  const modelPickerTitle = !supportsChat(provider)
      ? `${provider.name} cannot run chats here, so model size is unavailable.`
      : `Choose a model size for ${provider.name}'s default model.`
  return (
    <div className="conversation">
      <div className="conversation-header" {...getSectionProps('conversationHeader')}>
        <div>
          <h1 dir="auto">{chat.title}</h1>
          <span className="branch" title={projectPath}><FolderGit2 size={12} /><span className="branch__path">{projectPath || 'No project selected'}</span></span>
        </div>
        <div className="conversation-header__actions">
          <div className="provider-picker-wrap">
            <button ref={providerButtonRef} className="provider-picker" onClick={onProviderMenu} aria-haspopup="dialog" aria-expanded={providerMenuOpen} aria-controls={providerMenuId} title={providerPickerTitle}>
              <ProviderMark provider={provider} small />
              <span><small>{providerPickerMode}</small><strong>{provider.name}</strong></span>
              <ChevronDown size={14} />
            </button>
            {providerMenuOpen && createPortal(
              <div ref={providerMenuRef} id={providerMenuId} className="provider-menu provider-menu-portal floating-card" style={providerMenuStyle} role="dialog" aria-label={`Provider for ${chat.title}`}>
                <div className="floating-card__label">Provider for this chat</div>
                <button onClick={onProviderAuto}>
                  <Bot size={16} />
                  <span><strong>Auto provider</strong><small>Chooses by your Automatic fallback priority</small></span>
                  <em className={`model-usage-badge ${autoProvider.usage === null ? 'model-usage-badge--unknown' : ''}`} title={autoProvider.usageReason}>
                    {autoProvider.usage === null ? autoProvider.name : `${autoProvider.name} · ${autoProvider.usage}%`}
                  </em>
                  {automaticMode && <Check size={15} />}
                </button>
                <div className="menu-separator" />
                {[...providers]
                  .sort((a, b) => {
                    const aAvailable = a.connected && supportsChat(a) ? 0 : 1
                    const bAvailable = b.connected && supportsChat(b) ? 0 : 1
                    return aAvailable - bAvailable
                  })
                  .map((item) => (
                  <button key={item.id} disabled={!item.connected || !supportsChat(item)} onClick={() => onProviderChange(item.id)} title={supportsChat(item) ? item.status : `${item.name} chat execution is not supported yet.`}>
                    <ProviderMark provider={item} />
                    <span><strong>{item.name}</strong><small>{item.connected && supportsChat(item) ? `${item.usage === null ? 'Usage not reported' : `${item.usage}% used`} · Provider default model` : supportsChat(item) ? item.status : 'Chat execution not supported'}</small></span>
                    {!automaticMode && chat.provider === item.id && <Check size={15} />}
                  </button>
                ))}
                <div className="menu-separator" />
                <button onClick={onConnect}><Plus size={16} /><span><strong>Connect another CLI</strong><small>Uses the local Ensync Host</small></span></button>
              </div>,
              document.body,
            )}
          </div>
          <div className="provider-picker-wrap model-picker-wrap">
            <button
              ref={modelButtonRef}
              className="provider-picker model-picker"
              onClick={onModelMenu}
              aria-label={`Model size for ${chat.title}: ${modelPickerLabel}. ${modelPickerContext}`}
              aria-haspopup="dialog"
              aria-expanded={modelMenuOpen}
              aria-controls={modelMenuId}
              disabled={modelPickerDisabled}
              title={modelPickerTitle}
            >
              <SlidersHorizontal size={16} />
              <span><small>{modelPickerContext}</small><strong>{modelPickerLabel}</strong></span>
              <ChevronDown size={14} />
            </button>
            {modelMenuOpen && createPortal(
              <div ref={modelMenuRef} id={modelMenuId} className="provider-menu provider-menu-portal floating-card" style={modelMenuStyle} role="dialog" aria-label={`Model size for ${chat.title}`}>
                <div className="floating-card__label">Model size for {provider.name}</div>
                <button onClick={() => onSizeTierChange(null)}>
                  <SlidersHorizontal size={16} />
                  <span><strong>Provider default</strong><small>Uses {provider.name}'s default model settings</small></span>
                  <em className="model-usage-badge model-usage-badge--unknown">Default</em>
                  {!chat.sizeTier && <Check size={15} />}
                </button>
                {MODEL_SIZE_OPTIONS.map((option) => (
                  <button key={option.tier} onClick={() => onSizeTierChange(option.tier)}>
                    <TerminalSquare size={16} />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description} · keeps the provider's default model</small>
                    </span>
                    {chat.sizeTier === option.tier && <Check size={15} />}
                  </button>
                ))}
                <p className="provider-menu__empty-models">Size adjusts reasoning depth over the provider's own default model. It never invents or carries a model name across providers.</p>
              </div>,
              document.body,
            )}
          </div>
        </div>
      </div>

      <div className="message-scroll-shell">
        <div className="message-scroll" ref={messageScrollRef} onScroll={onMessageScroll}>
          <ChatContextHeader chat={chat} />
          <div className="message-column" ref={messageColumnRef}>
          {chat.messages.length === 0 ? (
            <EmptyConversation provider={provider} />
          ) : (
            chat.messages.map((message) => {
              const messageProvider = providers.find((item) => item.id === message.provider) ?? provider
              return message.role === 'user' ? (
                <div className="message message--user" key={message.id}>
                  <div className="message__avatar user-avatar">MH</div>
                  <div className="message__body"><div className="message__meta"><strong>You</strong><span>{message.time}{message.deliveryStatus === 'queued' ? ` · queued ${queuedPrompts.findIndex((item) => item.turnId === message.turnId) + 1}` : message.deliveryStatus === 'failed' ? ' · run failed' : message.deliveryStatus === 'cancelled' ? ' · stopped' : message.deliveryStatus === 'interrupted' ? ' · interrupted' : message.deliveryStatus === 'transferred' ? ' · transferred to active run' : ''}</span></div>{isLongMessageContent(message.content) ? <MessageContent content={message.content} collapsible /> : typeof window.ensyncDesktop?.openPath === 'function' ? <MessageContent content={message.content} projectPath={projectPath} /> : <MessageContent content={message.content} onOpenFile={onOpenFile} />}{message.attachments && message.attachments.length > 0 && <div className="message-attachments">{message.attachments.map((attachment) => <span key={attachment.path} title={attachment.path}><Paperclip size={12} />{attachment.name}</span>)}</div>}<div className="message-actions"><CopyTextButton text={message.content} label="Copy message" /></div></div>
                </div>
              ) : (
                <div className="message message--agent" key={message.id}>
                  <ProviderMark provider={messageProvider} />
                  <div className="message__body"><div className="message__meta"><strong>{messageProvider.name}</strong><span>{message.time}</span></div>{message.executionTarget && <div className="message__run-meta"><TerminalSquare size={11} /> {message.model ?? 'Model not reported by CLI'}{message.sizeTier ? ` · ${modelSizeLabel(message.sizeTier)}` : ' · Provider default'} · {message.executionTarget} · {message.sessionResumable ? 'session resumable' : 'new handoff next turn'}</div>}{isLongMessageContent(message.content) ? <MessageContent content={message.content} collapsible /> : typeof window.ensyncDesktop?.openPath === 'function' ? <MessageContent content={message.content} projectPath={projectPath} /> : <MessageContent content={message.content} onOpenFile={onOpenFile} />}<div className="message-actions"><CopyTextButton text={message.content} label="Copy message" /></div></div>
                </div>
              )
            })
          )}
          {sending && providerNotes.length > 0 && (
            <div className="provider-live-notes" role="log" aria-live="polite" aria-label="Provider notes">
              {providerNotes.map((note, index) => {
                const noteProvider = providers.find((item) => item.id === note.provider) ?? provider
                return (
                  <div className="provider-live-note" key={`${note.sequence ?? note.at}-${index}`}>
                    <ProviderMark provider={noteProvider} small />
                    <div>
                      <strong>{noteProvider.name} note</strong>
                      {typeof window.ensyncDesktop?.openPath === 'function'
                        ? <MessageContent content={note.text} projectPath={projectPath} />
                        : <MessageContent content={note.text} onOpenFile={onOpenFile} />}
                      {note.redacted && <small>Possible secret redacted by Ensync Host.</small>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {/* What the agent wrote to the person before asking is an ordinary
              message, not progress commentary, so it is rendered as one: it is
              the answer the question card hangs off, and the run's final reply
              never repeats it. */}
          {pendingQuestion?.message && (
            <div className="message message--agent" key={`question-message-${pendingQuestion.questionId}`}>
              <ProviderMark provider={questionMessageProvider} />
              <div className="message__body">
                <div className="message__meta"><strong>{questionMessageProvider.name}</strong><span>{new Date(pendingQuestion.askedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
                {typeof window.ensyncDesktop?.openPath === 'function'
                  ? <MessageContent content={pendingQuestion.message} projectPath={projectPath} />
                  : <MessageContent content={pendingQuestion.message} onOpenFile={onOpenFile} />}
                <div className="message-actions"><CopyTextButton text={pendingQuestion.message} label="Copy message" /></div>
              </div>
            </div>
          )}
          {sending && <div className="working-line">
            <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
            <em aria-hidden="true">{elapsedWorkingLabel ?? '• Working'}</em>
            <span className="copy-announcement">{provider.name} is working in this chat.</span>
          </div>}
          {queuedPrompts.length > 0 && (
            <div className={`prompt-queue-status ${occupiedRun ? 'prompt-queue-status--occupied' : ''} ${queueGate.state === 'paused' ? 'prompt-queue-status--paused' : ''}`} role="status">
              <History size={13} />
              <span className="prompt-queue-status__copy">
                <strong>{occupiedRun ? `${activeRunProviderName ?? occupiedRun.provider} is active in another window` : queueStatus.headline}</strong>
                <span>{occupiedRun
                  ? `${occupiedElapsedLabel ? `${occupiedElapsedLabel}. ` : ''}${occupiedRunReason ?? 'This message remains queued until the active run can accept it.'}`
                  : queueStatus.detail}</span>
              </span>
              {canViewOccupiedRun && <button type="button" className="prompt-queue-status__view" onClick={onViewOccupiedRun}>View active run</button>}
              {canPushQueuedNow && <button type="button" className="prompt-queue-status__push" onClick={onPushQueuedNow} disabled={pushingQueued} title="Deliver the first queued message to the active Codex turn now">{pushingQueued ? 'Pushing…' : 'Push now'}</button>}
              {canStopAndSendNow && (
                <button
                  type="button"
                  className={`prompt-queue-status__stop-send${stopAndSendArmed ? ' prompt-queue-status__stop-send--armed' : ''}`}
                  onClick={() => {
                    if (!stopAndSendArmed) {
                      setStopAndSendArmed(true)
                      return
                    }
                    setStopAndSendArmed(false)
                    onStopAndSendNow()
                  }}
                  title={`${activeRunProviderName ?? provider.name} cannot take a new instruction mid-turn. This stops the current turn, discarding its in-progress work, and runs the queued message immediately. The stopped turn is not retried.`}
                >{stopAndSendArmed ? 'Confirm stop & send' : 'Stop & send now'}</button>
              )}
              {queueGate.state === 'paused' && !occupiedRun && <button type="button" onClick={onResumeQueue} title="Run only the next queued message; do not retry the previous turn">{queueStatus.actionLabel}</button>}
            </div>
          )}
          {!sending && chat.messages.at(-1)?.deliveryStatus === 'cancelled' && (
            <div className="chat-run-stopped" role="status">
              <Square size={13} />
              <span>Stopped. Partial project changes may exist; review them before retrying.</span>
            </div>
          )}
          {error && <div className="chat-run-error" role="alert">
            <CircleHelp size={15} />
            <span>{error}</span>
            {retryableTurn && (
              <button
                type="button"
                className="chat-run-error__retry"
                onClick={onRetryFailedTurn}
                title={`Ensync verified this attempt changed nothing. Send the same instruction to ${provider.name} again as a new turn.`}
              ><RotateCw size={12} /> Retry</button>
            )}
          </div>}
          </div>
        </div>
        {pendingLatest && (
          <button
            className="jump-to-latest"
            type="button"
            onClick={jumpToLatest}
            aria-label={`New activity in ${chat.title}. Jump to latest.`}
          >
            <ArrowDown size={14} />
            Jump to latest
          </button>
        )}
      </div>

      {chat.workspace && (
        <div className="chat-workspace-status" role="status" title={chat.workspace.path}>
          <ShieldCheck size={14} />
          <span><strong>Protected branch</strong> {chat.workspace.branch}</span>
          <small>Shared checkout unchanged</small>
        </div>
      )}

      {(sending || executionEvents.length > 0) && (
        <ExecutionPanel
          events={executionEvents}
          sending={sending}
          providerName={provider.name}
          open={executionPanelOpen}
          onOpenChange={onExecutionPanelOpenChange}
          onStop={onStop}
        />
      )}

      {pendingQuestion && (
        <ProviderQuestionCard
          pending={pendingQuestion}
          disabled={answeringQuestionId === pendingQuestion.questionId}
          error={questionError}
          onAnswer={(payload) => void submitQuestionAnswer(payload)}
          onSkip={(questionId) => void submitQuestionAnswer({ questionId, cancelled: true })}
        />
      )}

      {owningConversation && (
        <OwningConversationBanner
          target={owningConversation}
          onOpen={onOpenOwningConversation}
        />
      )}

      <div className="composer-zone" {...getSectionProps('composerStatus')}>
        <div className="composer">
          {attachments.length > 0 && (
            <div className="composer__attachments" aria-label="Attached files">
              {attachments.map((attachment) => (
                <span key={attachment.path} title={attachment.path}>
                  <Paperclip size={13} />
                  <span>{attachment.name}</span>
                  <button type="button" onClick={() => onAttachmentRemove(attachment.path)} aria-label={`Remove ${attachment.name}`}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={composerRef}
            data-chat-composer={chat.id}
            dir="auto"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend() }
            }}
            placeholder={canRunChat ? `Ask ${provider.name} to build, change, or fix anything…` : provider.connected ? `Chat execution for ${provider.name} is not supported yet` : `Connect ${provider.name} before sending, or enable Automatic fallback`}
            rows={1}
          />
          {attachmentError && <div className="composer__attachment-error" role="status"><CircleHelp size={13} />{attachmentError}</div>}
          <div className="composer__toolbar">
            <div className="composer__context-actions">
              <button className="composer__context-button" type="button" onClick={onFilesChoose} disabled={!filePickerAvailable} title={filePickerAvailable ? 'Add files' : filePickerUnavailableMessage} aria-label={filePickerAvailable ? 'Add files' : `Add files unavailable: ${filePickerUnavailableMessage}`}><Plus size={17} /></button>
              <button className="context-chip" onClick={onContext} title={projectContextAvailable ? 'Ensync Host found .relay context files' : 'No .relay context files verified by Ensync Host'}><FileText size={13} /><span className="context-chip__label">Project context</span>{projectContextAvailable ? <Check size={12} /> : <CircleHelp size={12} />}</button>
              <button className={`context-chip auto-context-chip ${autoContextSkill ? 'auto-context-chip--active' : ''}`} onClick={onAutoContextSkillChange} role="switch" aria-checked={autoContextSkill} title="Preserve complete project and conversation context when continuing or handing off between providers"><Bot size={13} /><span className="context-chip__label">Auto Context</span>{autoContextSkill ? <Check size={12} /> : null}</button>
            </div>
            <div className="composer__submit-actions">
              <span className="shortcut">{composerQueueState.hint}</span>
              {composerQueueState.stopVisible && <button className="stop-button" type="button" onClick={onStop} aria-label={`Stop ${provider.name} in this chat`} title="Stop current run; queued prompts pause"><Square size={13} /></button>}
              <button className={`send-button ${composerQueueState.sendEnabled ? 'send-button--ready' : ''}`} onClick={onSend} disabled={!composerQueueState.sendEnabled} aria-label={composerQueueState.sendLabel} title={sending ? 'Queue after the current turn' : 'Send'}><ArrowUp size={17} /></button>
            </div>
          </div>
        </div>
        <button className="fallback-status" onClick={onSettings}>
          <span className="fallback-stack">
            {fallbackProviders.slice(0, 3).map((item) => <i key={item.id} style={{ background: item.color }} />)}
          </span>
          <span className="fallback-status__label">Auto-fallback {autoFallback ? 'on' : 'off'} · {fallbackProviders.length} routing candidates{autoContextSkill ? ' · context synced' : ''}</span>
          <ChevronRight size={12} />
        </button>
      </div>
      {!isVisible('composerStatus') && (
        <div className="composer-recovery-zone">
          <button type="button" onClick={() => setVisible('composerStatus', true)}>
            <MessageSquareText size={15} />
            Show chat box
          </button>
        </div>
      )}
    </div>
  )
}

function OwningConversationBanner({
  target,
  onOpen,
}: {
  target: ReferencedOwningConversation
  onOpen: (target: ReferencedOwningConversation) => Promise<boolean>
}) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setOpening(false)
    setError(null)
  }, [target.chatId, target.workspaceId])

  const open = async () => {
    if (opening) return
    setOpening(true)
    setError(null)
    try {
      const focused = await onOpen(target)
      if (focused) return
      setError('Ensync could not open that retained conversation. Quit Ensync completely and reopen it, then try again.')
    } catch {
      setError('Ensync could not open that retained conversation. Quit Ensync completely and reopen it, then try again.')
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="owning-conversation-banner" role={error ? 'alert' : 'status'} aria-live="polite">
      <GitBranch size={16} aria-hidden="true" />
      <span>
        <strong>This task belongs to “{target.chatTitle}”</strong>
        <small>{target.projectName} · protected conversation {target.branch}</small>
        {error && <em>{error}</em>}
      </span>
      <button type="button" onClick={() => void open()} disabled={opening}>
        {opening ? 'Opening…' : 'Open owning conversation'}
      </button>
    </div>
  )
}

function ExecutionPanel({
  events,
  sending,
  providerName,
  open,
  onOpenChange,
  onStop,
}: {
  events: ChatExecutionEvent[]
  sending: boolean
  providerName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onStop: () => void
}) {
  const outputRef = useRef<HTMLPreElement>(null)
  const latestProviderNote = [...events].reverse().find((event) => event.type === 'note')

  useLayoutEffect(() => {
    if (!open || !outputRef.current) return
    outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [events, open])

  return (
    <section className={`execution-panel ${open ? 'execution-panel--open' : ''}`} aria-label={`${providerName} CLI execution`}>
      <div className="execution-panel__bar">
        <button
          className="execution-panel__header"
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${providerName} CLI execution`}
          title={`${open ? 'Collapse' : 'Expand'} CLI execution`}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <TerminalSquare size={14} />
          <strong>{sending ? 'Live CLI execution' : 'CLI execution'}</strong>
          {sending && <span className="execution-panel__live"><i /> running</span>}
          <small title={latestProviderNote?.type === 'note' ? latestProviderNote.text : undefined}>
            {latestProviderNote?.type === 'note'
              ? `Latest note: ${latestProviderNote.text.replace(/\s+/g, ' ').trim()}`
              : 'Provider notes and CLI-visible output · hidden reasoning is never available'}
          </small>
        </button>
        {sending && <button className="execution-panel__stop" type="button" onClick={onStop} aria-label={`Stop ${providerName} in this chat`}><Square size={11} /> Stop</button>}
      </div>
      {open && (
        <pre className="execution-panel__output" ref={outputRef} aria-live="polite" dir="auto">
          {events.length === 0 && sending && <span className="execution-panel__host">[Ensync Host] Waiting for the CLI process to start…</span>}
          {events.map((event, index) => {
            if (event.type === 'note') {
              return <span className="execution-panel__note" key={`${event.at}-${index}`}>[{event.provider} note] {event.text}{event.redacted ? '\n[Ensync Host] Possible secret redacted from this note.' : ''}{'\n'}</span>
            }
            if (event.type === 'notice') {
              return <span className="execution-panel__host" key={`${event.at}-${index}`}>[Ensync Host] {event.message}{'\n'}</span>
            }
            if (event.type === 'started') {
              return <span className="execution-panel__command" key={`${event.at}-${index}`}># cwd: {event.cwd}{'\n'}$ {event.command}{'\n'}</span>
            }
            if (event.type === 'output') {
              return <span className={`execution-panel__${event.stream}`} key={`${event.at}-${index}`}>{event.text}{event.redacted ? '\n[Ensync Host] Possible secret redacted from this output.\n' : ''}</span>
            }
            if (event.type === 'question') {
              return (
                <span className="execution-panel__host" key={`${event.at}-${index}`}>
                  {'\n'}[{event.provider} question] {event.questions.map((question) => question.question).join(' ')}{'\n'}
                </span>
              )
            }
            if (event.type === 'question_resolved') {
              return (
                <span className="execution-panel__host" key={`${event.at}-${index}`}>
                  [Ensync Host] {event.cancelled
                    ? 'The question was not answered; the provider was told so.'
                    : `Answer sent: ${event.answers.map((answer) => answer.answer).join(' · ')}`}{'\n'}
                </span>
              )
            }
            return (
              <span className={`execution-panel__host execution-panel__host--${event.outcome}`} key={`${event.at}-${index}`}>
                {'\n'}[Ensync Host] {event.message}{event.safeToRetry ? ' Safe to retry before verified activity.' : ''}{'\n'}
              </span>
            )
          })}
        </pre>
      )}
    </section>
  )
}

function EmptyConversation({ provider }: { provider: Provider }) {
  return (
    <div className="empty-conversation">
      <div className="empty-orbit"><span /><ProviderMark provider={provider} /></div>
      <h2>What should we make?</h2>
      <p>Describe the outcome below. Ensync keeps the task, project context, and agent handoffs in sync.</p>
    </div>
  )
}

function ConnectionWizard({ providers, hostOnline, hostError, hasActiveRuns, onRefresh, onUpdateStarted, onClose }: { providers: Provider[]; hostOnline: boolean; hostError: string | null; hasActiveRuns: boolean; onRefresh: (force?: boolean) => Promise<boolean>; onUpdateStarted: () => void; onClose: () => void }) {
  const [selected, setSelected] = useState<ProviderId>('claude')
  const [busyAction, setBusyAction] = useState<'connect' | 'update' | 'refresh' | null>(null)
  const [feedback, setFeedback] = useState<{ providerId: ProviderId; action: 'connect' | 'update' | 'refresh'; command: string | null; message: string } | null>(null)
  const [error, setError] = useState<{ providerId: ProviderId; message: string } | null>(null)
  const provider = providers.find((item) => item.id === selected) ?? providers[0]
  const selectedFeedback = feedback?.providerId === selected ? feedback : null
  const selectedError = error?.providerId === selected ? error.message : null
  const providerStateLabel = (item: Provider) => {
    if (item.installed === false) return 'Not installed'
    if (item.installed === null) return 'Not checked'
    if (item.connected) return item.accountLogin ? `Connected as ${item.accountLogin}` : 'Authenticated'
    if (item.authenticationState === 'not_authenticated') return 'Not authenticated'
    if (item.id === 'copilot') return 'Account check unavailable'
    return 'Login not checked'
  }

  const connect = async () => {
    const targetProviderId = selected
    setBusyAction('connect')
    setError(null)
    try {
      const result = await ensyncHost.connect(targetProviderId, true)
      setFeedback({ providerId: targetProviderId, action: 'connect', command: result.command.display, message: result.message })
    } catch (connectError) {
      setError({
        providerId: targetProviderId,
        message: connectError instanceof Error ? connectError.message : 'Unable to start the CLI login flow.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const updateProvider = async () => {
    const targetProviderId = selected
    setBusyAction('update')
    setError(null)
    try {
      const result = await ensyncHost.updateProvider(targetProviderId, true)
      if (result.started) onUpdateStarted()
      setFeedback({ providerId: targetProviderId, action: 'update', command: result.command.display, message: result.message })
    } catch (updateError) {
      setError({
        providerId: targetProviderId,
        message: updateError instanceof Error ? updateError.message : 'Unable to start the CLI update flow.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const checkAgain = async () => {
    const targetProviderId = selected
    setBusyAction('refresh')
    setError(null)
    try {
      const refreshed = await onRefresh(true)
      if (!refreshed) {
        setError({
          providerId: targetProviderId,
          message: 'Provider status was not refreshed because Ensync Host did not respond.',
        })
        return
      }
      setFeedback({ providerId: targetProviderId, action: 'refresh', command: null, message: 'Provider status refreshed from the installed CLI.' })
    } catch (refreshError) {
      setError({
        providerId: targetProviderId,
        message: refreshError instanceof Error ? refreshError.message : 'Unable to refresh provider status.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wizard-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header"><div><span className="eyebrow">AGENT CONNECTIONS</span><h2>Bring your own CLI</h2><p>Ensync uses your existing subscriptions. Credentials stay with each provider.</p></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
        <div className="wizard-body">
            <div className="provider-grid">
              {providers.map((item) => (
                <button className={`provider-card ${selected === item.id ? 'provider-card--selected' : ''}`} key={item.id} onClick={() => { setSelected(item.id); setFeedback(null); setError(null) }}>
                  <ProviderMark provider={item} /><span><strong>{item.name}</strong><small>{providerStateLabel(item)}{item.chatExecution === 'discovery_only' ? ' · Ensync runner not ready' : ''}</small></span>{item.connected && <CheckCircle2 className="connected-check" size={16} />}
                </button>
              ))}
            </div>
            <div className="connection-panel">
              <div className="guided-connect"><div className="guided-icon"><ProviderMark provider={provider} /></div><div><strong>{provider.installed ? `${provider.name}: ${providerStateLabel(provider).toLowerCase()}` : `${provider.name} is unavailable`}</strong><p>{provider.version ? `Installed ${provider.version} · ` : ''}{provider.id === 'copilot' && provider.connected ? 'Verified directly by Copilot CLI.' : provider.status}</p></div></div>
              <p>{provider.catalogReason}</p>
              {provider.documentationUrl && (
                <a className="official-install-link" href={provider.documentationUrl} target="_blank" rel="noreferrer">
                  <Cloud size={17} />
                  <span><strong>{provider.installed ? 'Installation and update guide' : `Install ${provider.name}`}</strong><small>Open the official vendor instructions</small></span>
                  <ArrowRight size={16} />
                </a>
              )}
              {provider.installed && provider.updateReason && <div className={`provider-update-note ${provider.canUpdate ? 'provider-update-note--available' : ''}`}><RotateCw size={14} /><span>{provider.updateReason}</span></div>}
              {hasActiveRuns && provider.canUpdate && <div className="connection-error" role="status">Finish active agent runs before updating an installed CLI.</div>}
              {selectedFeedback?.command && <div className="install-command"><code>{selectedFeedback.command}</code><CopyTextButton text={selectedFeedback.command} label={`Copy ${provider.name} ${selectedFeedback.action === 'update' ? 'update' : 'login'} command`} showLabel={false} /></div>}
              {selectedFeedback && <div className="inline-success"><CheckCircle2 size={15} /> {selectedFeedback.message}</div>}
              {selectedError && <div className="connection-error" role="alert">{selectedError}</div>}
              {!hostOnline && <div className="connection-error" role="alert">Ensync Host is offline. {hostError ?? 'Run npm run dev to start it.'}</div>}
              <div className="platform-note"><Check size={14} /> Status comes directly from the installed CLI <span>·</span> macOS and Windows supported</div>
            </div>
          </div>
        <div className="modal__footer"><button className="button button--ghost" onClick={onClose}>Close</button><button className="button button--ghost" onClick={checkAgain} disabled={busyAction !== null || !hostOnline}>{busyAction === 'refresh' ? <><RotateCw className="spin" size={15} /> Checking…</> : 'Check again'}</button>{provider.installed && provider.canUpdate && <button className="button button--ghost" onClick={updateProvider} disabled={busyAction !== null || !hostOnline || hasActiveRuns} title={hasActiveRuns ? 'Finish active agent runs before updating' : `Run ${provider.name}'s official self-update command`}>{busyAction === 'update' ? <><RotateCw className="spin" size={15} /> Opening update…</> : <><RotateCw size={15} /> Update agent</>}</button>}{!provider.connected && <button className="button button--primary" onClick={connect} disabled={busyAction !== null || !hostOnline || !provider.installed || !provider.canConnect}>{busyAction === 'connect' ? <><RotateCw className="spin" size={15} /> Opening…</> : provider.id === 'copilot' ? 'Open Copilot' : provider.setupKind === 'interactive_onboarding' ? 'Open setup in terminal' : 'Open login in terminal'}</button>}</div>
      </div>
    </div>
  )
}

function AccountSyncSettings({ status, phase, message, chatCount, onAuthenticate, onLogout, onSync }: { status: AccountSyncStatus; phase: 'checking' | 'idle' | 'syncing' | 'error'; message: string | null; chatCount: number; onAuthenticate: (mode: 'register' | 'login', username: string, password: string) => Promise<void>; onLogout: () => Promise<void>; onSync: () => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const busy = phase === 'checking' || phase === 'syncing'
  const lastSynced = status.lastSyncedAt
    ? new Date(status.lastSyncedAt).toLocaleString()
    : 'Not synced yet'

  const authenticate = async (mode: 'register' | 'login') => {
    if (busy || !username.trim() || password.length < 12) return
    try {
      await onAuthenticate(mode, username.trim(), password)
      setPassword('')
    } catch {
      // The parent owns the durable, user-visible error state.
    }
  }

  return (
    <section className="setting-section account-sync-setting">
      <div className="setting-title">
        <div><h3>Account &amp; chat sync</h3><p>Use one username to keep your conversation history available across your computers.</p></div>
        {status.authenticated && <span className="account-sync-badge"><i /> SYNC ON</span>}
      </div>
      {phase === 'checking' ? (
        <div className="account-sync-unavailable"><RotateCw className="spin" size={17} /><span><strong>Checking account sync</strong><small>Asking the local Ensync Host for its configured service.</small></span></div>
      ) : !status.configured ? (
        <div className="account-sync-unavailable"><Cloud size={18} /><span><strong>Account sync is not configured in this build</strong><small>Set an HTTPS ENSYNC_SYNC_SERVICE_URL for the Host. Ensync will not pretend a cloud account exists.</small></span></div>
      ) : status.authenticated ? (
        <div className="account-sync-connected">
          <div className="account-sync-profile"><span><UserRound size={18} /></span><p><strong>{status.username}</strong><small>{chatCount} {chatCount === 1 ? 'conversation' : 'conversations'} · last sync {lastSynced}</small></p><span className="account-sync-encryption"><LockKeyhole size={13} /> AES-256</span></div>
          <div className="account-sync-actions">
            <p><ShieldCheck size={14} /><span>Chats are encrypted before upload. CLI logins, provider sessions, terminal output, queued work, and local attachments stay on this computer.</span></p>
            <button type="button" className="button button--ghost" onClick={() => void onSync().catch(() => {})} disabled={busy}><RotateCw className={busy ? 'spin' : ''} size={14} /> {busy ? 'Syncing…' : 'Sync now'}</button>
            <button type="button" className="button button--ghost" onClick={() => void onLogout()} disabled={busy}><LogOut size={14} /> Sign out</button>
          </div>
          <small className="account-sync-session-note">For now, login stays only in Ensync Host memory. Restarting the Host requires signing in again; synchronized chats remain in your account.</small>
        </div>
      ) : (
        <form className="account-sync-form" onSubmit={(event) => { event.preventDefault(); void authenticate('login') }}>
          <label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={32} placeholder="your-name" disabled={busy} /></label>
          <label><span>Password</span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" minLength={12} maxLength={256} placeholder="At least 12 characters" disabled={busy} /></label>
          <div className="account-sync-form__actions"><button type="button" className="button button--ghost" onClick={() => void authenticate('register')} disabled={busy || !username.trim() || password.length < 12}>Create account</button><button type="submit" className="button button--primary" disabled={busy || !username.trim() || password.length < 12}>{busy ? 'Connecting…' : 'Sign in & sync'}</button></div>
          <p><LockKeyhole size={13} /> Your password is used for account login and local encryption-key derivation. It is never stored in the conversation snapshot.</p>
        </form>
      )}
      {message && <div className={phase === 'error' ? 'connection-error' : 'account-sync-message'} role={phase === 'error' ? 'alert' : 'status'}>{message}</div>}
    </section>
  )
}

function AgentUpdateSettings({ preferences, providers, onModeChange, onReview }: { preferences: AgentUpdatePreferences; providers: Provider[]; onModeChange: (mode: AgentUpdateMode) => void; onReview: () => void }) {
  const lastCycle = preferences.lastMaintenanceAt
    ? new Date(preferences.lastMaintenanceAt).toLocaleString()
    : 'No review or update cycle yet'
  const commandProviders = providers.filter((provider) => provider.updateStrategy === 'ensync_command')
  const providerManaged = providers.filter((provider) => provider.updateStrategy === 'provider_automatic')
  const guideOnly = providers.filter((provider) => provider.updateStrategy === 'official_guide')
  const options: Array<{ mode: AgentUpdateMode; title: string; detail: string }> = [
    { mode: 'remind', title: 'Remind weekly', detail: 'Review every installed provider. No command runs.' },
    { mode: 'automatic', title: 'Automatic weekly', detail: 'When idle, run verified updaters and flag providers that still need their guide.' },
    { mode: 'manual', title: 'Manual only', detail: 'Update from Agent Connections or the provider’s official guide.' },
  ]

  return (
    <section className="setting-section agent-update-setting">
      <div className="setting-title">
        <div><h3>Agent updates</h3><p>Keep supported local CLIs maintained without guessing versions from a package registry.</p></div>
        <button type="button" className="button button--ghost" onClick={onReview}><RotateCw size={14} /> Review now</button>
      </div>
      <div className="agent-update-policy" role="radiogroup" aria-label="Agent update policy">
        {options.map((option) => (
          <button key={option.mode} type="button" role="radio" aria-checked={preferences.mode === option.mode} className={preferences.mode === option.mode ? 'selected' : ''} onClick={() => onModeChange(option.mode)}>
            <span>{option.mode === 'remind' ? <Bell size={16} /> : option.mode === 'automatic' ? <RotateCw size={16} /> : <ShieldCheck size={16} />}</span>
            <strong>{option.title}</strong>
            <small>{option.detail}</small>
            {preferences.mode === option.mode && <Check size={14} />}
          </button>
        ))}
      </div>
      <div className="agent-update-provider-summary">
        <div>
          <strong>{providers.length > 0 ? `${providers.length} installed provider${providers.length === 1 ? '' : 's'} covered` : 'No provider CLIs installed'}</strong>
          <small>{providers.length > 0 ? providers.map((provider) => `${provider.name} ${provider.version ?? 'version not reported'}`).join(' · ') : 'Install a provider CLI to enable update reviews.'}</small>
        </div>
        <span>Last cycle: {lastCycle}</span>
      </div>
      {providers.length > 0 && <p className="agent-update-trust"><ShieldCheck size={14} /><span>{commandProviders.length} fixed native {commandProviders.length === 1 ? 'updater' : 'updaters'} · {providerManaged.length} provider-managed automatic · {guideOnly.length} official-guide only. Ensync never guesses a package manager or launches updates during an active Host run.</span></p>}
    </section>
  )
}

function SettingsModal({ providers, placement, setPlacement, conversationLayout, setConversationLayout, autoFallback, setAutoFallback, autoContextSkill, setAutoContextSkill, fallbackProviderOrder, setFallbackProviderOrder, agentUpdatePreferences, setAgentUpdateMode, installedAgentProviders, onReviewAgentUpdates, accountSyncStatus, accountSyncPhase, accountSyncMessage, syncedChatCount, onAccountAuthenticate, onAccountLogout, onAccountSync, onClose }: { providers: Provider[]; placement: NewTabPlacement; setPlacement: (value: NewTabPlacement) => void; conversationLayout: ConversationLayoutMode; setConversationLayout: (value: ConversationLayoutMode) => void; autoFallback: boolean; setAutoFallback: (value: boolean) => void; autoContextSkill: boolean; setAutoContextSkill: (value: boolean) => void; fallbackProviderOrder: ProviderId[]; setFallbackProviderOrder: (value: ProviderId[]) => void; agentUpdatePreferences: AgentUpdatePreferences; setAgentUpdateMode: (mode: AgentUpdateMode) => void; installedAgentProviders: Provider[]; onReviewAgentUpdates: () => void; accountSyncStatus: AccountSyncStatus; accountSyncPhase: 'checking' | 'idle' | 'syncing' | 'error'; accountSyncMessage: string | null; syncedChatCount: number; onAccountAuthenticate: (mode: 'register' | 'login', username: string, password: string) => Promise<void>; onAccountLogout: () => Promise<void>; onAccountSync: () => Promise<void>; onClose: () => void }) {
  const rankedProviders = orderedAutomaticProviders(providers, fallbackProviderOrder)
  const moveProvider = (providerId: ProviderId, direction: -1 | 1) => {
    const current = normalizeFallbackProviderOrder(fallbackProviderOrder)
    const index = current.indexOf(providerId)
    const destination = index + direction
    if (index < 0 || destination < 0 || destination >= current.length) return
    const next = [...current]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    setFallbackProviderOrder(next)
  }
  const routingStatus = (provider: Provider) => {
    if (!provider.connected) return provider.installed ? 'Not authenticated' : 'Not connected'
    if (!supportsChat(provider)) return 'Chat runner not tested'
    if (provider.usage === null) return 'Usage unavailable · last resort'
    if (provider.usage >= 100) return `${provider.usage}% used · skipped`
    return `${provider.usage}% used · available`
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header compact"><div><span className="eyebrow">PREFERENCES</span><h2>Make Ensync yours</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
        <div className="settings-body">
          <AccountSyncSettings status={accountSyncStatus} phase={accountSyncPhase} message={accountSyncMessage} chatCount={syncedChatCount} onAuthenticate={onAccountAuthenticate} onLogout={onAccountLogout} onSync={onAccountSync} />
          <section className="setting-section workspace-layout-setting">
            <div className="setting-title"><div><h3>New conversation view</h3><p>Choose whether open conversations share the screen or use one workspace.</p></div></div>
            <div className="choice-row layout-choice-row" role="radiogroup" aria-label="New conversation view">
              <button type="button" role="radio" aria-checked={conversationLayout === 'tabs'} className={conversationLayout === 'tabs' ? 'selected' : ''} onClick={() => setConversationLayout('tabs')}><span className="layout-mini layout-mini--tabs"><i /><i /><i /></span><strong>Open as tab</strong><small>Show one conversation at a time</small>{conversationLayout === 'tabs' && <Check size={15} />}</button>
              <button type="button" role="radio" aria-checked={conversationLayout === 'split'} className={conversationLayout === 'split' ? 'selected' : ''} onClick={() => setConversationLayout('split')}><span className="layout-mini layout-mini--split"><i /><i /></span><strong>Open in split pane</strong><small>Keep conversations side by side</small>{conversationLayout === 'split' && <Check size={15} />}</button>
            </div>
            {conversationLayout === 'split' && (
              <div className="split-position-setting">
                <div className="setting-title"><div><h3>New split pane position</h3><p>Choose where each new pane joins the workspace.</p></div></div>
                <div className="choice-row" role="radiogroup" aria-label="New split pane position">
                  <button type="button" role="radio" aria-checked={placement === 'adjacent'} className={placement === 'adjacent' ? 'selected' : ''} onClick={() => setPlacement('adjacent')}><span className="tab-mini"><i /><i className="highlight" /><i /></span><strong>Beside current pane</strong><small>Keep related work together</small>{placement === 'adjacent' && <Check size={15} />}</button>
                  <button type="button" role="radio" aria-checked={placement === 'end'} className={placement === 'end' ? 'selected' : ''} onClick={() => setPlacement('end')}><span className="tab-mini"><i /><i /><i className="highlight" /></span><strong>At the end</strong><small>Keep panes chronological</small>{placement === 'end' && <Check size={15} />}</button>
                </div>
              </div>
            )}
          </section>
          <DisplayPreferences />
          <CompletionNotificationPreferences className="setting-section" />
          <UIVisibilityPreferences />
          <NativeUpdatePreferences />
          <AgentUpdateSettings preferences={agentUpdatePreferences} providers={installedAgentProviders} onModeChange={setAgentUpdateMode} onReview={onReviewAgentUpdates} />
          <section className="setting-section">
          </section>
          <section className="setting-section">
            <div className="setting-title"><div><h3>Ensync Auto Context skill</h3><p>Keep one task synchronized with Auto or a provider you pin, on this computer or the selected SSH/VM worker.</p></div><Toggle enabled={autoContextSkill} onChange={() => setAutoContextSkill(!autoContextSkill)} label="Ensync Auto Context skill" /></div>
            <div className={`auto-context-summary ${autoContextSkill ? 'auto-context-summary--active' : ''}`}>
              <div><Bot size={16} /><span><strong>Your provider choice</strong><small>Use Auto, Codex, or Claude independently</small></span></div>
              <div><SlidersHorizontal size={16} /><span><strong>Your model size</strong><small>Provider default, Small, Medium, Large, or XL</small></span></div>
              <div><Layers3 size={16} /><span><strong>Complete handoff</strong><small>Project, transcript, decisions, target, and continuation state</small></span></div>
              <div><ShieldCheck size={16} /><span><strong>Safe continuation</strong><small>Fallback remains a separate setting</small></span></div>
            </div>
          </section>
          <section className="setting-section">
            <div className="setting-title"><div><h3>Automatic fallback</h3><p>Continue with the next subscription when an agent is unavailable or out of usage. This is independent from Auto Context; priority is top to bottom and saves automatically.</p></div><Toggle enabled={autoFallback} onChange={() => setAutoFallback(!autoFallback)} label="Automatic fallback" /></div>
            <p className="fallback-priority-note"><ShieldCheck size={13} /> Auto chooses the first ranked provider with verified usage below 100%. Unreported usage is tried only when no provider has verified remaining capacity.</p>
            <div className={`fallback-list ${autoFallback ? '' : 'disabled'}`}>
              {rankedProviders.map((provider, index) => (
                <div className={`fallback-row ${provider.connected ? '' : 'fallback-row--unavailable'}`} key={provider.id}>
                  <span className="order-number">{index + 1}</span>
                  <ProviderMark provider={provider} small />
                  <span><strong>{provider.name}</strong><small>{provider.plan ?? 'Plan not reported'} · {provider.model ?? 'Provider default model'}</small></span>
                  <div className={`usage-meter ${provider.usage === null ? 'usage-meter--unknown' : ''}`}>{provider.usage !== null && <i style={{ width: `${Math.min(100, provider.usage)}%`, background: provider.color }} />}</div>
                  <em title={provider.usageReason}>{routingStatus(provider)}{providerResetText(provider) ? ` · ${providerResetText(provider)}` : ''}</em>
                  <div className="fallback-order-controls">
                    <button type="button" aria-label={`Move ${provider.name} higher`} title="Move higher" disabled={index === 0} onClick={() => moveProvider(provider.id, -1)}><ArrowUp size={13} /></button>
                    <button type="button" aria-label={`Move ${provider.name} lower`} title="Move lower" disabled={index === rankedProviders.length - 1} onClick={() => moveProvider(provider.id, 1)}><ArrowDown size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
        <div className="modal__footer"><span className="saved-note"><Check size={13} /> Changes save automatically</span><button className="button button--primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}

function ProjectSwitcher({ projects, activeProject, hostError, onInspect, onOpenGit, onOpenRemote, onClose }: { projects: RelayProject[]; activeProject: RelayProject; hostError: string | null; onInspect: (path: string) => Promise<void>; onOpenGit: (mode: 'clone' | 'manage') => void; onOpenRemote: () => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<string | null>(hostError)
  const nativePickerAvailable = nativeProjectFolderPickerAvailable()
  const busy = inspecting || choosing
  const filtered = projects.filter((project) => project.name.toLowerCase().includes(query.toLowerCase()) || project.path.toLowerCase().includes(query.toLowerCase()))

  const inspect = async (path: string) => {
    if (!path.trim() || busy) return
    setInspecting(true)
    setError(null)
    try {
      await onInspect(path.trim())
    } catch (inspectError) {
      setError(inspectError instanceof Error ? inspectError.message : 'Ensync Host could not inspect that folder.')
    } finally {
      setInspecting(false)
    }
  }

  const chooseFolder = async () => {
    if (busy) return
    setChoosing(true)
    const result = await chooseNativeProjectFolder()
    if (result.status === 'cancelled') {
      setChoosing(false)
      return
    }
    if (result.status !== 'selected') {
      setError(result.message)
      setChoosing(false)
      return
    }

    setQuery(result.path)
    setError(null)
    try {
      await onInspect(result.path)
    } catch (inspectError) {
      setError(inspectError instanceof Error ? inspectError.message : 'Ensync Host could not inspect that folder.')
    } finally {
      setChoosing(false)
    }
  }

  return (
    <div className="modal-backdrop project-backdrop" onMouseDown={onClose}>
      <div className="modal project-modal" onMouseDown={(event) => event.stopPropagation()}>
        <form className="project-search" onSubmit={(event) => { event.preventDefault(); void inspect(query) }}>
          <Search size={17} />
          <input id="ensync-project-path" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Enter an absolute local path" />
          {nativePickerAvailable && <button type="button" className="project-choose-folder" onClick={() => void chooseFolder()} disabled={busy}><FolderOpen size={14} />{choosing ? 'Choosing…' : 'Choose folder'}</button>}
          {query.trim() ? <button type="submit" disabled={busy}>{inspecting ? 'Checking…' : 'Inspect & focus'}</button> : !nativePickerAvailable && <kbd>esc</kbd>}
        </form>
        <div className="project-modal__body">
          <div className="project-section-label">RECENT LOCAL WORKSPACES</div>
          <div className="project-list">
            {filtered.map((project) => (
              <button
                className={activeProject.id === project.id ? 'active' : ''}
                style={{ '--project-color': project.color } as React.CSSProperties}
                key={project.id}
                onClick={() => void inspect(project.path)}
                disabled={busy}
                aria-current={activeProject.id === project.id ? 'true' : undefined}
              >
                <span className="project-icon"><FolderGit2 size={18} /></span>
                <span className="project-copy"><strong>{project.name}</strong><small>{project.path}</small></span>
                <span className="project-meta"><em>Local folder</em><small>{project.verified ? `${project.context.files.length} .relay files inspected` : 'Recheck before focusing'}</small></span>
                {activeProject.id === project.id && project.verified ? <span className="open-badge"><i /> FOCUSED</span> : <ChevronRight size={15} />}
              </button>
            ))}
            {filtered.length === 0 && !query.trim() && <div className="project-empty">No recent projects yet. Enter an absolute path above.</div>}
          </div>
          {error && <div className="project-error" role="alert"><CircleHelp size={15} /><span>{error}</span></div>}
          <div className="project-section-label">OPEN SOMETHING ELSE</div>
          <div className="project-actions">
            <button type="button" onClick={() => void chooseFolder()} disabled={busy || !nativePickerAvailable} title={nativePickerAvailable ? 'Open the system folder chooser' : 'Available in the Ensync desktop app'}><span><FolderOpen size={16} /></span><p><strong>Choose local folder</strong><small>{nativePickerAvailable ? 'Finder or File Explorer' : 'Desktop app only · use the path above'}</small></p></button>
            <button type="button" onClick={() => onOpenGit('clone')}><span><GitFork size={16} /></span><p><strong>Import repository</strong><small>Clone with your installed Git</small></p></button>
            <button type="button" onClick={() => onOpenGit('manage')} disabled={!activeProject.verified} title={activeProject.verified ? 'Inspect remotes and choose a push mode' : 'Focus a local project first'}><span><GitBranch size={16} /></span><p><strong>Git connection &amp; push</strong><small>{activeProject.verified ? 'Real status and guarded pushes' : 'Focus a project first'}</small></p></button>
            <button type="button" onClick={onOpenRemote}><span><Cloud size={16} /></span><p><strong>Open remote project</strong><small>Verify an SSH worker and project</small></p></button>
          </div>
        </div>
        <div className="project-focus-note"><Layers3 size={15} /><div><strong>Ensync Host verifies every focus change</strong><p>Chats and CLI runs use the canonical local path returned by the host.</p></div><ShieldCheck size={15} /></div>
      </div>
    </div>
  )
}

function ContextModal({ project, onClose }: { project: RelayProject; onClose: () => void }) {
  const adapters = [
    { provider: 'claude', name: 'Claude Code', file: 'CLAUDE.md', mark: 'AI', className: 'claude-color' },
    { provider: 'codex', name: 'Codex', file: 'AGENTS.md', mark: '◎', className: 'codex-color' },
  ] as const
  const contextVerified = project.verified
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal context-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header compact"><div><span className="eyebrow">{project.name.toUpperCase()} · PROJECT CONTEXT</span><h2>Context found on disk</h2><p>Ensync reports only files observed in the currently focused folder.</p></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
        <div className="context-map">
          <div className="context-core"><div className="relay-file"><FileText size={20} /><strong>.relay/</strong><small>{contextVerified ? project.context.error ?? (project.context.relayDirectory ? `${project.context.files.length} files found` : 'Directory not found') : 'Not inspected by Ensync Host'}</small></div>{project.context.files.slice(0, 40).map((file) => <div className="context-file" key={file}><span />{file}<Check size={13} /></div>)}{project.context.files.length === 0 && <div className="context-file"><span />No .relay files found</div>}{project.context.files.length > 40 && <div className="context-file"><span />{project.context.files.length - 40} more files reported by host</div>}{project.context.truncated && <div className="context-file"><span />File list truncated by host safety limit</div>}</div>
          <ArrowRight size={18} className="context-arrow" />
          <div className="agent-outputs">{adapters.map((adapter) => {
            const detected = contextVerified && project.context.instructionAdapters.some((item) => item.provider === adapter.provider && item.file === adapter.file)
            return <div key={adapter.provider}><span className={`output-logo ${adapter.className}`}>{adapter.mark}</span><p><strong>{adapter.name}</strong><small>{adapter.file} · {detected ? 'found' : 'not found'}</small></p>{detected ? <CheckCircle2 size={15} /> : <CircleHelp size={15} />}</div>
          })}</div>
        </div>
        <div className="sync-banner"><span><FileText size={15} /></span><div><strong>{contextVerified ? 'Inspection completed by Ensync Host' : 'No current host inspection'}</strong><p>{project.path || 'Select and inspect a local project'}{contextVerified ? ` · ${project.context.featureFiles.length} feature Markdown files · inspected ${new Date(project.inspectedAt).toLocaleTimeString()}` : ''}</p></div></div>
        <div className="modal__footer"><button className="button button--primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}

function RemoteRuntimeModal({ hostOnline, providers, project, chat, executionTarget, initialRuntime, fallbackProviderOrder, onExecutionTargetChange, onClose }: { hostOnline: boolean; providers: Provider[]; project: RelayProject; chat: Chat | null; executionTarget: ExecutionTarget; initialRuntime: 'local' | 'remote' | 'virtualbox'; fallbackProviderOrder: ProviderId[]; onExecutionTargetChange: (target: ExecutionTarget) => void; onClose: () => void }) {
  const [tab, setTab] = useState<'runtime' | 'telegram'>('runtime')
  const [runtime, setRuntime] = useState<'local' | 'remote' | 'virtualbox'>(executionTarget.kind === 'ssh' ? 'remote' : initialRuntime)
  const [botToken, setBotToken] = useState('')
  const [telegramContextError, setTelegramContextError] = useState<string | null>(null)
  const installedCount = providers.filter((provider) => provider.installed).length
  const connectedCount = providers.filter((provider) => provider.routeKind === 'subscription' && provider.connected).length

  useEffect(() => {
    if (!hostOnline || !project.verified || !chat) return
    let cancelled = false
    const provider = providerForChat(providers, chat, fallbackProviderOrder)
    if (!supportsChat(provider)) {
      setTelegramContextError(`${provider.name} is discovery-only and cannot run Telegram tasks yet.`)
      return
    }
    void telegramHostClient.setTaskContext({
      projectId: project.id,
      projectLabel: project.name,
      projectPath: project.path,
      conversationId: chat.id,
      provider: provider.id,
      executionTarget: executionTarget.kind === 'ssh'
        ? { kind: 'ssh', connection: executionTarget.connection }
        : { kind: 'local' },
    }).then(() => {
      if (!cancelled) setTelegramContextError(null)
    }).catch((error: unknown) => {
      if (!cancelled) setTelegramContextError(error instanceof Error ? error.message : 'Telegram task context could not be selected.')
    })
    return () => { cancelled = true }
  }, [chat, executionTarget, fallbackProviderOrder, hostOnline, project, providers])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal remote-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header compact">
          <div><span className="eyebrow">REMOTE RUNTIME</span><h2>Keep your agents within reach</h2><p>Use subscriptions on a computer you control — no per-token API required.</p></div>
          <button className="icon-button" onClick={onClose}><X size={19} /></button>
        </div>
        <div className="modal-tabs">
          <button className={tab === 'runtime' ? 'active' : ''} onClick={() => setTab('runtime')}><Server size={15} /> Runtime host</button>
          <button className={tab === 'telegram' ? 'active' : ''} onClick={() => setTab('telegram')}><Smartphone size={15} /> Telegram access</button>
        </div>
        {tab === 'runtime' ? (
          <div className="remote-body">
            <div className="runtime-options">
              <button className={runtime === 'local' ? 'selected' : ''} onClick={() => setRuntime('local')}>
                <span className="runtime-icon"><Server size={19} /></span><span><strong>This computer</strong><small>Fastest setup</small></span>{runtime === 'local' && <Check size={15} />}
              </button>
              <button className={runtime === 'remote' ? 'selected' : ''} onClick={() => setRuntime('remote')}>
                <span className="runtime-icon"><Cloud size={19} /></span><span><strong>Remote machine</strong><small>Connect over SSH</small></span>{runtime === 'remote' && <Check size={15} />}
              </button>
              <button className={runtime === 'virtualbox' ? 'selected' : ''} onClick={() => setRuntime('virtualbox')}>
                <span className="runtime-icon"><Boxes size={19} /></span><span><strong>VirtualBox</strong><small>Guided local VM</small></span>{runtime === 'virtualbox' && <Check size={15} />}
              </button>
            </div>
            <div className={`runtime-setup ${runtime === 'virtualbox' ? 'runtime-setup--virtualbox' : ''}`}>
              {runtime === 'local' && (
                <div className="local-runtime">
                  <div className={`runtime-status-card ${hostOnline ? '' : 'runtime-status-card--offline'}`}><span className="large-status"><i /></span><div><strong>{hostOnline ? 'Ensync Host responded' : 'Ensync Host is offline'}</strong><p>{hostOnline ? 'Verified through the loopback health and provider endpoints.' : 'Run npm run dev to start the local host and web app together.'}</p></div><span className="status-badge">{hostOnline ? 'ONLINE' : 'OFFLINE'}</span></div>
                  <div className="runtime-detail-grid"><div><small>Host endpoint</small><strong>{hostOnline ? 'This computer · loopback only' : 'Not connected'}</strong></div><div><small>CLIs found</small><strong>{installedCount}</strong></div><div><small>Authenticated</small><strong>{connectedCount}</strong></div><div><small>Telemetry</small><strong>{hostOnline ? 'CLI status only' : 'Unavailable'}</strong></div></div>
                  <div className="runtime-callout"><ShieldCheck size={16} /><span><strong>Subscription-only probes</strong><small>The host removes model API-key variables from status and login processes.</small></span></div>
                  {executionTarget.kind === 'ssh' && <button className="button button--primary runtime-activate" onClick={() => onExecutionTargetChange({ kind: 'local' })} disabled={!hostOnline}>Use this computer for chats</button>}
                </div>
              )}
              {runtime === 'remote' && (
                <div className="remote-form">
                  {executionTarget.kind === 'ssh' && (
                    <div className="runtime-status-card remote-active-runtime"><span className="large-status"><i /></span><div><strong>{executionTarget.connection.username}@{executionTarget.connection.hostname}</strong><p>{executionTarget.probe.project.canonicalPath ?? executionTarget.connection.projectPath}</p></div><span className="status-badge">ACTIVE</span></div>
                  )}
                  <RemoteSshSetup
                    probeConnection={(connection) => remoteSshHost.probe(connection)}
                    initialProjectPath={project.path}
                    onVerified={(connection, probe) => {
                      if (probe.node.available && probe.providers.some(remoteSubscriptionReady)) {
                        onExecutionTargetChange({ kind: 'ssh', connection, probe })
                      }
                    }}
                  />
                </div>
              )}
              {runtime === 'virtualbox' && (
                <VirtualBoxSetup className="ensync-vbox--embedded" />
              )}
            </div>
          </div>
        ) : (
          <div className="telegram-body">
            {telegramContextError && <div className="connection-error" role="alert">{telegramContextError}</div>}
            {!project.verified || !chat ? <div className="runtime-callout"><CircleHelp size={16} /><span><strong>Select a project conversation first</strong><small>Telegram tasks need a verified project and conversation before approval.</small></span></div> : null}
            <TelegramSetup
              host={hostOnline
                ? { status: 'available', hostLabel: 'Local Ensync Host', encryptedCredentialStorage: false }
                : { status: 'unavailable', message: 'Start Ensync Host before pairing Telegram.' }}
              botToken={botToken}
              onBotTokenChange={setBotToken}
              client={hostOnline ? telegramHostClient : undefined}
            />
          </div>
        )}
        <div className="modal__footer">
          <span className="saved-note"><ShieldCheck size={13} /> {executionTarget.kind === 'ssh' ? `Chats use ${executionTarget.connection.hostname}` : 'Chats use this computer'} · only verified states are shown</span>
          <button className="button button--primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

function UsageDashboard({ providers, modelTelemetry, hostOnline, onRefresh, autoFallback, fallbackProviderOrder, onClose }: { providers: Provider[]; modelTelemetry: ModelTelemetry[]; hostOnline: boolean; onRefresh: (force?: boolean) => Promise<boolean>; autoFallback: boolean; fallbackProviderOrder: ProviderId[]; onClose: () => void }) {
  const [refreshing, setRefreshing] = useState(false)
  const routeProviders = orderedAutomaticProviders(providers, fallbackProviderOrder)
    .filter((provider) => provider.connected && supportsChat(provider))
  const authenticatedCount = providers.filter((provider) => provider.connected).length
  const checkedAt = providers.find((provider) => provider.checkedAt)?.checkedAt

  const providerMeta = (provider: Provider) => {
    const reportedAccountDetails = [provider.plan, provider.model].filter((value): value is string => Boolean(value))
    if (reportedAccountDetails.length > 0) return reportedAccountDetails.join(' · ')
    if (provider.routeKind === 'local') return provider.installed ? 'Local runtime detected' : 'Not installed'
    if (provider.connected) return provider.accountLogin ? `Connected as ${provider.accountLogin}` : 'Authenticated subscription'
    if (provider.id === 'copilot' && provider.installed) return provider.authenticationState === 'not_authenticated' ? 'Not authenticated' : 'Account check unavailable'
    if (provider.installed) return provider.authenticationState === 'not_authenticated' ? 'Not authenticated' : 'Installed · login not checked'
    return 'Not installed'
  }

  const compactUsageReason = (provider: Provider) => {
    if (provider.usageKind === 'local_runtime') return 'Local runtime; no subscription quota.'
    if (provider.usageKind === 'session_only') return 'Only per-run usage is available.'
    if (provider.usageKind === 'unavailable') return 'No machine-readable quota data.'
    if (provider.chatExecution === 'supported') return 'CLI quota data was not returned.'
    return 'No verified non-consuming quota probe.'
  }

  // A retained percentage stays on the card so a lost probe race cannot blank it,
  // but it is never presented as this refresh's reading.
  const staleUsageNote = (provider: Provider) => {
    const measuredAt = provider.usageCheckedAt ? new Date(provider.usageCheckedAt) : null
    return measuredAt && !Number.isNaN(measuredAt.getTime())
      ? `Last verified ${measuredAt.toLocaleTimeString()}; this check returned no quota data.`
      : 'Last verified earlier; this check returned no quota data.'
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await onRefresh(true)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal usage-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header compact"><div><span className="eyebrow">CLI TELEMETRY</span><h2>Provider status and usage</h2><p>Only verified CLI values are shown. Unreported values stay blank.</p></div><button className="icon-button" aria-label="Close usage dashboard" onClick={onClose}><X size={19} /></button></div>
        <div className="usage-summary"><div><span className={`live-pulse ${hostOnline ? '' : 'live-pulse--offline'}`} /><p><strong>{hostOnline ? `${authenticatedCount} authenticated CLIs` : 'Ensync Host offline'}</strong><small>{checkedAt ? `Checked ${new Date(checkedAt).toLocaleTimeString()}` : 'No verified check yet'}</small></p></div><button onClick={refresh} disabled={refreshing || !hostOnline}><RotateCw className={refreshing ? 'spin' : ''} size={14} /> Refresh status</button></div>
        <div className="usage-modal__body">
          <div className="plan-cards">
            {providers.map((provider) => (
              <div className={`plan-card ${provider.usage !== null && provider.usage >= 90 ? 'plan-card--warning' : ''}`} key={provider.id}>
                <div className="plan-card__head"><ProviderMark provider={provider} /><div><strong>{provider.name}</strong><small>{providerMeta(provider)}</small></div><span className={`source-badge ${provider.usageSource}`}>{provider.usageSource === 'cli' ? 'CLI' : 'No CLI data'}</span></div>
                <div className="plan-usage">{provider.usage !== null
                  ? <><strong>{provider.usage}%</strong><span>of current window used</span></>
                  : provider.usageKind === 'local_runtime'
                    ? <><strong>{provider.usageDetails.find((item) => item.label === 'Installed models')?.value ?? '—'}</strong><span>local models installed</span></>
                    : provider.usageKind === 'session_only'
                      ? <><strong>Per run</strong><span>session totals only</span></>
                      : <><strong>—</strong><span>quota unavailable</span></>}</div>
                <div className={`plan-meter ${provider.usage === null ? 'plan-meter--unknown' : ''}`}>{provider.usage !== null && <i style={{ width: `${provider.usage}%`, background: provider.color }} />}</div>
                {provider.usageDetails.length > 0 && <dl className="usage-details">{provider.usageDetails.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
                <div className="plan-card__foot"><span>{providerResetText(provider) ? <strong>{providerResetText(provider)}</strong> : 'Reset not reported'}</span><span>{provider.routeKind === 'local' ? (provider.installed ? 'Local runtime' : 'Not installed') : provider.connected ? 'Authenticated' : provider.installed ? provider.authenticationState === 'not_authenticated' ? 'Not authenticated' : 'Login not checked' : 'Not installed'}</span></div>
                {provider.usage === null
                  ? <p className="usage-unavailable-reason" title={provider.usageReason}>{compactUsageReason(provider)}</p>
                  : provider.usageStale && <p className="usage-unavailable-reason" title={provider.usageReason}>{staleUsageNote(provider)}</p>}
              </div>
            ))}
          </div>
          <section className="model-telemetry">
            <div className="model-telemetry__heading"><h3>Exact run usage by model</h3><span>Reported by CLI processes only</span></div>
            {modelTelemetry.length === 0 ? <p className="model-telemetry__empty">No CLI-reported token totals yet. A completed Codex, Claude, or Factory Droid run will appear here only when its CLI reports usage.</p> : modelTelemetry.map((item) => {
              const provider = providers.find((entry) => entry.id === item.provider) ?? providers[0]
              return <div className="model-telemetry__row" key={`${item.provider}-${item.model}`}><ProviderMark provider={provider} small /><span><strong>{item.model}</strong><small>{provider.name} · {item.runs} verified {item.runs === 1 ? 'run' : 'runs'}</small></span><dl><div><dt>Input</dt><dd>{item.inputTokens?.toLocaleString() ?? 'Not reported'}</dd></div><div><dt>Output</dt><dd>{item.outputTokens?.toLocaleString() ?? 'Not reported'}</dd></div><div><dt>Cached</dt><dd>{item.cachedInputTokens?.toLocaleString() ?? 'Not reported'}</dd></div></dl></div>
            })}
          </section>
          <div className="route-card"><div className="route-card__head"><div><h3>Automatic plan routing</h3><p>{autoFallback ? 'Uses your saved top-to-bottom priority and safely advances after a verified pre-activity failure.' : 'Automatic fallback is currently disabled.'}</p></div><span className={autoFallback ? 'route-on' : 'route-off'}>{autoFallback ? 'ON' : 'OFF'}</span></div><div className="route-line">{routeProviders.map((provider, index) => <div className="route-node" key={provider.id}><span>{index + 1}</span><ProviderMark provider={provider} small /><strong>{provider.name}</strong>{index < routeProviders.length - 1 && <ArrowRight size={15} />}</div>)}</div></div>
          <div className="usage-note"><CircleHelp size={15} /><p><strong>Why meters are blank</strong><span>Most CLIs do not expose safe account-quota data. Ensync leaves it blank instead of estimating it; verified runtime limit errors may still trigger fallback.</span></p></div>
        </div>
        <div className="modal__footer"><span className="saved-note"><Wifi size={13} /> {hostOnline ? 'Status read from local CLIs' : 'No host telemetry'}</span><button className="button button--primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}

function CommandPalette({ chats, onOpenChat, onNew, onSettings, onClose }: { chats: Chat[]; onOpenChat: (id: string) => void; onNew: () => void; onSettings: () => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const filtered = chats.filter((chat) => chat.title.toLowerCase().includes(query.toLowerCase())).slice(0, 5)
  return (
    <div className="command-backdrop" onMouseDown={onClose}>
      <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-input"><Search size={18} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" /><kbd>esc</kbd></div>
        <div className="command-results">
          {!query && <><span className="command-label">QUICK ACTIONS</span><button onClick={onNew}><Plus size={16} /><span>New conversation</span><kbd>Ctrl/⌘ T</kbd></button><button onClick={onSettings}><Settings size={16} /><span>Open preferences</span><kbd>Ctrl/⌘ ,</kbd></button></>}
          <span className="command-label">CONVERSATIONS</span>
          {filtered.map((chat) => <button key={chat.id} onClick={() => onOpenChat(chat.id)}><History size={15} /><span dir="auto">{chat.title}</span><small dir="auto">{chat.subtitle}</small></button>)}
        </div>
        <div className="command-footer"><span>Choose a visible result to open it</span><span className="command-brand"><Command size={12} /> Ensync</span></div>
      </div>
    </div>
  )
}

export default App

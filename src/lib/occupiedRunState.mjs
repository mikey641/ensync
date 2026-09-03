import {
  acceptTransferredPrompt,
  appendPromptToQueue,
  occupiedRunCanHandoff,
  occupiedRunCanNavigate,
} from './promptQueue.mjs'

const OCCUPIED_RUN_LIMIT = 128
const NATIVE_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TRANSCRIPT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

function nonEmptyString(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function exactString(left, right) {
  return nonEmptyString(left) && left === right
}

function normalizedOwner(owner, binding) {
  const ownerJobId = nonEmptyString(owner?.jobId, 256)
    ? owner.jobId
    : nonEmptyString(owner?.ownerJobId, 256)
      ? owner.ownerJobId
      : null
  const turnId = nonEmptyString(owner?.turnId, 256) ? owner.turnId : null
  if (!ownerJobId
    || !nonEmptyString(owner?.provider, 64)
    || !['local', 'ssh'].includes(owner?.targetKind)
    || !nonEmptyString(owner?.startedAt, 64)
    || !nonEmptyString(binding?.projectId, 256)
    || !nonEmptyString(binding?.projectPath)
    || !nonEmptyString(binding?.chatId, 256)) return null
  return {
    ownerJobId,
    turnId,
    provider: owner.provider,
    targetKind: owner.targetKind,
    startedAt: owner.startedAt,
    providerProcessStarted: owner.providerProcessStarted === true,
    steerable: owner.steerable === true,
    nativeWorkspaceId: typeof owner.nativeWorkspaceId === 'string'
      && NATIVE_WORKSPACE_ID_PATTERN.test(owner.nativeWorkspaceId)
      ? owner.nativeWorkspaceId.toLowerCase()
      : null,
    predecessorTranscriptFingerprint: typeof owner.predecessorTranscriptFingerprint === 'string'
      && TRANSCRIPT_FINGERPRINT_PATTERN.test(owner.predecessorTranscriptFingerprint)
      ? owner.predecessorTranscriptFingerprint
      : null,
    projectId: binding.projectId,
    projectPath: binding.projectPath,
    chatId: binding.chatId,
    // A bounded owner claim does not itself authorize this Host to control it.
    // The renderer sets this only after an exact Host job lookup succeeds.
    controllable: false,
  }
}

export function normalizeOccupiedRuns(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  for (const [chatId, candidate] of Object.entries(value)) {
    if (Object.keys(normalized).length >= OCCUPIED_RUN_LIMIT) break
    if (!nonEmptyString(chatId, 256) || candidate?.chatId !== chatId) continue
    const owner = normalizedOwner({
      jobId: candidate.ownerJobId,
      turnId: candidate.turnId,
      provider: candidate.provider,
      targetKind: candidate.targetKind,
      startedAt: candidate.startedAt,
      providerProcessStarted: candidate.providerProcessStarted,
      steerable: candidate.steerable,
      nativeWorkspaceId: candidate.nativeWorkspaceId,
      predecessorTranscriptFingerprint: candidate.predecessorTranscriptFingerprint,
    }, candidate)
    if (!owner) continue
    normalized[chatId] = { ...owner, controllable: false }
  }
  return normalized
}

/** A drained FIFO attempt keeps the immutable snapshot captured at enqueue. */
export function occupiedQueueSnapshotForAttempt(queuedPrompt, directSnapshot) {
  if (!queuedPrompt) return directSnapshot
  return {
    queueId: queuedPrompt.id,
    messageId: queuedPrompt.messageId,
    enqueuedAt: queuedPrompt.enqueuedAt,
    preferences: queuedPrompt.preferences,
  }
}

function sameQueuedIdentity(left, right) {
  return left?.id === right.id
    && left?.turnId === right.turnId
    && left?.messageId === right.messageId
    && left?.prompt === right.prompt
    && left?.enqueuedAt === right.enqueuedAt
    && (left?.resumeApprovedAt ?? null) === (right.resumeApprovedAt ?? null)
    && left?.predecessorTurnId === right.predecessorTurnId
    && JSON.stringify(left?.attachments ?? []) === JSON.stringify(right.attachments ?? [])
    && JSON.stringify(left?.preferences ?? null) === JSON.stringify(right.preferences)
}

/**
 * Converts the renderer's already-checkpointed pending message after Host
 * returns `occupied`. No new message, turn, or waiter job is introduced.
 */
export function convertPendingTurnToOccupiedQueue(input) {
  const owner = normalizedOwner(input?.owner, input?.binding)
  const chat = Array.isArray(input?.chats)
    ? input.chats.find((candidate) => candidate?.id === input.chatId)
    : null
  const message = chat?.messages?.find((candidate) => candidate?.id === input.messageId
    && candidate?.turnId === input.turnId
    && candidate?.role === 'user')
  if (!owner || owner.chatId !== input.chatId || !message
    || !nonEmptyString(input?.prompt, 100_000)
    || !nonEmptyString(input?.turnId, 256)
    || !nonEmptyString(input?.messageId, 256)
    || !nonEmptyString(input?.enqueuedAt, 64)
    || !input?.preferences || typeof input.preferences !== 'object') {
    return { status: 'invalid', chats: input?.chats ?? [], queues: input?.queues ?? {}, inFlightRuns: input?.inFlightRuns ?? {}, occupiedRuns: input?.occupiedRuns ?? {} }
  }

  const entry = {
    id: nonEmptyString(input.queueId, 256) ? input.queueId : `queue-${input.turnId}`,
    turnId: input.turnId,
    messageId: input.messageId,
    prompt: input.prompt,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    enqueuedAt: input.enqueuedAt,
    predecessorTurnId: owner.turnId,
    preferences: input.preferences,
  }
  const existing = input.queues?.[input.chatId]?.find((candidate) => candidate?.id === entry.id
    || candidate?.turnId === entry.turnId
    || candidate?.messageId === entry.messageId)
  if (existing) {
    const duplicate = sameQueuedIdentity(existing, entry)
      && message.deliveryStatus === 'queued'
      && input.occupiedRuns?.[input.chatId]?.ownerJobId === owner.ownerJobId
    return {
      status: duplicate ? 'duplicate' : 'invalid',
      chats: input.chats,
      queues: input.queues,
      inFlightRuns: input.inFlightRuns,
      occupiedRuns: input.occupiedRuns,
    }
  }
  if (message.deliveryStatus !== 'pending') {
    return { status: 'invalid', chats: input.chats, queues: input.queues, inFlightRuns: input.inFlightRuns, occupiedRuns: input.occupiedRuns }
  }

  const chats = input.chats.map((candidate) => candidate.id === input.chatId ? {
    ...candidate,
    subtitle: 'Message queued behind active run',
    messages: candidate.messages.map((item) => item.id === input.messageId
      ? { ...item, deliveryStatus: 'queued' }
      : item),
  } : candidate)
  const inFlightRuns = { ...(input.inFlightRuns ?? {}) }
  delete inFlightRuns[input.chatId]
  return {
    status: 'converted',
    chats,
    queues: appendPromptToQueue(input.queues ?? {}, input.chatId, entry),
    inFlightRuns,
    occupiedRuns: { ...(input.occupiedRuns ?? {}), [input.chatId]: owner },
  }
}

function exactEntryBinding(owner, entry, binding) {
  return exactString(entry?.predecessorTurnId, owner?.turnId)
    && exactString(entry?.preferences?.provider, owner?.provider)
    && exactString(entry?.preferences?.executionTargetKey, owner?.targetKind)
    && exactString(entry?.preferences?.projectId, owner?.projectId)
    && exactString(entry?.preferences?.projectPath, owner?.projectPath)
    && exactString(binding?.turnId, owner?.turnId)
}

export function occupiedRunControls(owner, entry, binding, {
  nativeAvailable = false,
  shellReachable = false,
} = {}) {
  const exactNative = nativeAvailable && shellReachable && occupiedRunCanNavigate(owner, binding)
  const sameHostLiveTurn = owner?.controllable === true
    && exactString(owner?.turnId, binding?.turnId)
  const canView = Boolean(exactNative && sameHostLiveTurn)
  const controllable = owner?.controllable === true && exactEntryBinding(owner, entry, binding)
  const canPush = controllable && exactNative && occupiedRunCanHandoff(owner, entry, binding)
  const canStopAndSend = Boolean(controllable
    && exactNative
    && !canPush
    && owner?.targetKind === 'local'
    && owner?.providerProcessStarted === true)
  let reason = null
  if (!nativeAvailable) {
    reason = 'Open the native Ensync app on this Host to view or control the active run. This message remains queued.'
  } else if (!exactNative) {
    reason = 'The active run is in another window or Host that this window cannot verify. This message remains queued.'
  } else if (!owner?.controllable) {
    reason = 'The active run cannot be controlled from this Host. This message remains queued.'
  }
  return { canView, canPush: Boolean(canPush), canStopAndSend, reason }
}

/** Stop approval belongs to the target-bound payload, never the source FIFO. */
export function handoffEntryForAction(entry, stopAndSend, approvedAt) {
  if (!stopAndSend) return entry
  if (!nonEmptyString(approvedAt, 64)) return null
  return { ...entry, resumeApprovedAt: approvedAt }
}

/** A first acceptance becomes visible in memory only after durable persistence. */
export function commitHandoffAcceptance(accepted, persist, apply) {
  if (accepted?.status !== 'accepted'
    || typeof persist !== 'function'
    || typeof apply !== 'function') return false
  let persisted = false
  try {
    persisted = persist({ chats: accepted.chats, promptQueues: accepted.queues }) === true
  } catch {
    return false
  }
  if (!persisted) return false
  apply(accepted)
  return true
}

/** Host polling is observational: it may update or remove controls, never FIFO. */
export function applyOccupiedJobObservation(occupiedRuns, chatId, observation) {
  const current = occupiedRuns?.[chatId]
  if (!current) return occupiedRuns ?? {}
  const next = { ...occupiedRuns }
  if (observation?.kind === 'terminal') {
    delete next[chatId]
    return next
  }
  if (observation?.kind === 'running') {
    next[chatId] = {
      ...current,
      controllable: true,
      providerProcessStarted: observation.providerProcessStarted === true,
      steerable: observation.steerable === true,
    }
    return next
  }
  if (observation?.kind === 'unavailable') {
    next[chatId] = {
      ...current,
      controllable: false,
      providerProcessStarted: false,
      steerable: false,
    }
  }
  return next
}

export function activeNativeRunBindings(inFlightRuns, workspaceId) {
  if (!nonEmptyString(workspaceId, 64)) return []
  return Object.entries(inFlightRuns ?? {}).flatMap(([chatId, run]) =>
    nonEmptyString(chatId, 256)
      && run?.executionTarget === 'local'
      && nonEmptyString(run?.jobId, 256)
      && nonEmptyString(run?.projectId, 256)
      && nonEmptyString(run?.projectPath)
      ? [{
          workspaceId,
          projectId: run.projectId,
          projectPath: run.projectPath,
          chatId,
          jobId: run.jobId,
        }]
      : [])
}

export function exactNativeFocusCanApply(request, currentBinding) {
  return Boolean(request && currentBinding
    && exactString(request.workspaceId, currentBinding.workspaceId)
    && exactString(request.projectId, currentBinding.projectId)
    && exactString(request.projectPath, currentBinding.projectPath)
    && exactString(request.chatId, currentBinding.chatId)
    && exactString(request.jobId, currentBinding.jobId))
}

/** Exact local terminal evidence is outcome-agnostic; FIFO gates decide reuse. */
export function completedNativeRunBinding(workspaceId, chatId, run) {
  if (typeof workspaceId !== 'string' || !NATIVE_WORKSPACE_ID_PATTERN.test(workspaceId)
    || !nonEmptyString(chatId, 256)
    || run?.executionTarget !== 'local'
    || !nonEmptyString(run?.jobId, 256)
    || !nonEmptyString(run?.turnId, 256)
    || !nonEmptyString(run?.provider, 64)
    || !nonEmptyString(run?.projectId, 256)
    || !nonEmptyString(run?.projectPath)) return null
  return {
    workspaceId: workspaceId.toLowerCase(),
    projectId: run.projectId,
    projectPath: run.projectPath,
    chatId,
    jobId: run.jobId,
    turnId: run.turnId,
    provider: run.provider,
    executionTarget: run.executionTarget,
  }
}

function exactHandoffPresentationTarget(request, context) {
  return Boolean(request?.target && context
    && exactString(request.target.workspaceId, context.workspaceId)
    && exactString(request.target.projectId, context.projectId)
    && exactString(request.target.projectPath, context.projectPath)
    && exactString(request.target.chatId, context.chatId)
    && exactString(request.handoffId, request.entry?.id))
}

/** Reconcile an exact target copy/tombstone before consulting live-run state. */
export function reconcileQueuedMessageHandoff(request, context) {
  if (!exactHandoffPresentationTarget(request, context)) {
    return { status: 'conflict', chats: context?.chats ?? [], queues: context?.queues ?? {} }
  }
  return acceptTransferredPrompt(
    context.queues ?? {},
    context.chats ?? [],
    context.chatId,
    request.entry,
  )
}

/** A shell-authorized handoff may finish racing the exact predecessor run. */
export function validateTerminalQueuedMessageHandoff(request, context) {
  const completedRun = context?.completedRun
  const entry = request?.entry
  return exactHandoffPresentationTarget(request, context)
    && exactNativeFocusCanApply(request?.target, completedRun)
    && exactString(entry?.predecessorTurnId, completedRun?.turnId)
    && exactString(entry?.preferences?.provider, completedRun?.provider)
    && exactString(entry?.preferences?.executionTargetKey, completedRun?.executionTarget)
    && exactString(entry?.preferences?.projectId, completedRun?.projectId)
    && exactString(entry?.preferences?.projectPath, completedRun?.projectPath)
}

/** Target-side check before any cross-window prompt content is persisted. */
export function validateQueuedMessageHandoff(request, context) {
  const activeRun = context?.activeRun
  const entry = request?.entry
  const queue = Array.isArray(context?.queue) ? context.queue : null
  const queueAcceptable = queue !== null
    && (queue.length === 0 || (queue.length === 1 && sameQueuedIdentity(queue[0], entry)))
  return exactNativeFocusCanApply(request?.target, {
    workspaceId: context?.workspaceId,
    projectId: context?.projectId,
    projectPath: context?.projectPath,
    chatId: context?.chatId,
    jobId: activeRun?.jobId,
  })
    && queueAcceptable
    && exactString(request?.handoffId, entry?.id)
    && exactString(entry?.predecessorTurnId, activeRun?.turnId)
    && exactString(entry?.preferences?.provider, activeRun?.provider)
    && exactString(entry?.preferences?.executionTargetKey, activeRun?.executionTarget)
    && exactString(entry?.preferences?.projectId, activeRun?.projectId)
    && exactString(entry?.preferences?.projectPath, activeRun?.projectPath)
}

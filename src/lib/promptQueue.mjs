function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizedAttachments(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  return value.filter((attachment) => {
    if (!attachment || typeof attachment !== 'object') return false
    const path = nonEmptyString(attachment.path)
    const name = nonEmptyString(attachment.name)
    if (!path || !name || seen.has(path)) return false
    seen.add(path)
    return true
  }).map((attachment) => ({ name: attachment.name.trim(), path: attachment.path.trim() }))
}

export function normalizePromptQueues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  for (const [chatId, entries] of Object.entries(value)) {
    if (!nonEmptyString(chatId) || !Array.isArray(entries)) continue
    const valid = entries.filter((entry) => entry
      && typeof entry === 'object'
      && nonEmptyString(entry.id)
      && nonEmptyString(entry.turnId)
      && nonEmptyString(entry.messageId)
      && nonEmptyString(entry.prompt)
      && entry.preferences
      && typeof entry.preferences === 'object')
      .map((entry) => ({ ...entry, attachments: normalizedAttachments(entry.attachments) }))
    if (valid.length > 0) normalized[chatId] = valid
  }
  return normalized
}

function normalizedQueuedPrompt(value) {
  return normalizePromptQueues({ handoff: [value] }).handoff?.[0] ?? null
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Stable delivery identity; timestamps are audit metadata, not prompt content. */
function queuedPromptIdentity(entry) {
  return canonicalJson({
    id: entry.id,
    turnId: entry.turnId,
    messageId: entry.messageId,
    predecessorTurnId: entry.predecessorTurnId ?? null,
    prompt: entry.prompt,
    attachments: entry.attachments,
    preferences: entry.preferences,
  })
}

export function appendPromptToQueue(queues, chatId, entry) {
  return { ...queues, [chatId]: [...(queues[chatId] ?? []), entry] }
}

export function removePromptFromQueue(queues, chatId, entryId) {
  const retained = (queues[chatId] ?? []).filter((entry) => entry.id !== entryId)
  if (retained.length === (queues[chatId] ?? []).length) return queues
  const next = { ...queues }
  if (retained.length > 0) next[chatId] = retained
  else delete next[chatId]
  return next
}

/**
 * The source retains this audit record after a target has durably accepted its
 * queue entry. It is intentionally not an executable queue state.
 */
export function markQueuedMessageTransferred(messages, messageId) {
  return messages.map((message) => message.id === messageId
    && message.role === 'user'
    && message.deliveryStatus === 'queued'
    ? { ...message, deliveryStatus: 'transferred' }
    : message)
}

/**
 * Persist a target-first handoff once. Every stable ID collision is checked
 * against the full queue snapshot so a retry cannot silently change a prompt.
 */
export function acceptTransferredPrompt(queues, chats, chatId, entry) {
  const normalized = normalizedQueuedPrompt(entry)
  const targetIndex = Array.isArray(chats)
    ? chats.findIndex((chat) => chat?.id === chatId)
    : -1
  if (!normalized || targetIndex < 0) return { status: 'conflict', queues, chats }

  const target = chats[targetIndex]
  const existingEntries = Array.isArray(queues?.[chatId]) ? queues[chatId] : []
  const collisions = existingEntries.filter((existing) =>
    existing?.id === normalized.id
    || existing?.turnId === normalized.turnId
    || existing?.messageId === normalized.messageId)
  const sameIdentity = collisions.length === 1
    && queuedPromptIdentity(collisions[0]) === queuedPromptIdentity(normalized)
  if (collisions.length > 0) {
    const existingMessage = target.messages?.find((message) => message?.id === normalized.messageId)
    return sameIdentity && existingMessage?.role === 'user'
      && existingMessage.turnId === normalized.turnId
      && existingMessage.content === normalized.prompt
      && existingMessage.deliveryStatus === 'queued'
      ? { status: 'duplicate', queues, chats }
      : { status: 'conflict', queues, chats }
  }

  if ((target.messages ?? []).some((message) =>
    message?.id === normalized.messageId || message?.turnId === normalized.turnId)) {
    return { status: 'conflict', queues, chats }
  }

  const message = {
    id: normalized.messageId,
    role: 'user',
    turnId: normalized.turnId,
    content: normalized.prompt,
    time: normalized.enqueuedAt,
    deliveryStatus: 'queued',
    ...(normalized.attachments.length > 0 ? { attachments: normalized.attachments } : {}),
  }
  return {
    status: 'accepted',
    queues: { ...queues, [chatId]: [...existingEntries, normalized] },
    chats: chats.map((chat, index) => index === targetIndex
      ? { ...chat, messages: [...(chat.messages ?? []), message] }
      : chat),
  }
}

/**
 * Consume only the FIFO head after Host-confirmed live delivery. The next
 * queued prompt, if any, now follows the active logical turn instead of the
 * consumed prompt's former standalone turn.
 */
export function promoteQueuedPromptToActiveTurn(queues, chatId, entryId, activeTurnId) {
  const entries = queues[chatId] ?? []
  const promoted = entries[0]
  if (!promoted || promoted.id !== entryId || !nonEmptyString(activeTurnId)) return queues

  const retained = entries.slice(1)
  if (retained[0]?.predecessorTurnId === promoted.turnId) {
    retained[0] = { ...retained[0], predecessorTurnId: activeTurnId.trim() }
  }
  const next = { ...queues }
  if (retained.length > 0) next[chatId] = retained
  else delete next[chatId]
  return next
}

export function approveNextQueuedPrompt(queues, chatId, approvedAt) {
  const entries = queues[chatId] ?? []
  if (entries.length === 0) return queues
  return {
    ...queues,
    [chatId]: [
      { ...entries[0], resumeApprovedAt: approvedAt },
      ...entries.slice(1),
    ],
  }
}

export function predecessorTurnIdForPrompt(queue, messages, inFlightRun) {
  const lastQueuedTurnId = queue.at(-1)?.turnId
  if (lastQueuedTurnId) return lastQueuedTurnId
  if (nonEmptyString(inFlightRun?.turnId)) return inFlightRun.turnId
  return [...messages].reverse().find((message) =>
    message?.role === 'user' && message.deliveryStatus === 'pending')?.turnId ?? null
}

/** A Host job can exist while provider preflight or workspace setup is still running. */
export function activeCodexTurnCanAcceptSteering(activeRun) {
  return activeRun?.provider === 'codex'
    && activeRun.executionTarget === 'local'
    && activeRun.providerProcessStarted === true
    && Boolean(nonEmptyString(activeRun.jobId))
}

/** Match Push now to the exact started turn and its captured project/target. */
export function queuedPromptCanSteerActiveTurn(entry, activeRun) {
  return activeCodexTurnCanAcceptSteering(activeRun)
    && entry?.predecessorTurnId === activeRun.turnId
    && entry?.preferences?.executionTargetKey === activeRun.executionTarget
    && entry?.preferences?.projectId === activeRun.projectId
    && entry?.preferences?.projectPath === activeRun.projectPath
}

/**
 * Stop-and-send is the only mid-turn delivery available on providers that
 * cannot be steered. It is destructive — the running turn is cancelled, not
 * corrected — so it is offered only where live steering is genuinely
 * unavailable, and only for a head that still binds to the running turn's
 * exact snapshot. It is never a synonym for Push now.
 */
export function queuedPromptCanStopAndSendNow(entry, activeRun, { liveSteerAvailable = false } = {}) {
  if (liveSteerAvailable) return false
  if (!nonEmptyString(activeRun?.turnId)) return false
  return entry?.predecessorTurnId === activeRun.turnId
    && entry?.preferences?.executionTargetKey === activeRun.executionTarget
    && entry?.preferences?.projectId === activeRun.projectId
    && entry?.preferences?.projectPath === activeRun.projectPath
}

function exactOwnerJobId(owner) {
  const ownerJobId = nonEmptyString(owner?.ownerJobId)
  const hostJobId = nonEmptyString(owner?.jobId)
  if (ownerJobId && hostJobId && ownerJobId !== hostJobId) return null
  return ownerJobId ?? hostJobId
}

function sameNonEmptyString(left, right) {
  const normalizedLeft = nonEmptyString(left)
  const normalizedRight = nonEmptyString(right)
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight
}

/** Exact live native roster bindings are required before focusing another window. */
export function occupiedRunCanNavigate(owner, currentBinding) {
  const jobId = exactOwnerJobId(owner)
  return owner?.targetKind === 'local'
    && currentBinding?.targetKind === 'local'
    && Boolean(jobId)
    && jobId === currentBinding?.jobId
    && sameNonEmptyString(owner?.nativeWorkspaceId, currentBinding?.workspaceId)
    && sameNonEmptyString(owner?.projectId, currentBinding?.projectId)
    && sameNonEmptyString(owner?.projectPath, currentBinding?.projectPath)
    && sameNonEmptyString(owner?.chatId, currentBinding?.chatId)
    && sameNonEmptyString(owner?.provider, currentBinding?.provider)
}

/** Push handoff adds exact local-Codex turn and queue-snapshot checks to navigation. */
export function occupiedRunCanHandoff(owner, entry, currentBinding) {
  const normalized = normalizedQueuedPrompt(entry)
  return occupiedRunCanNavigate(owner, currentBinding)
    && owner?.provider === 'codex'
    && owner?.providerProcessStarted === true
    && owner?.steerable === true
    && Boolean(normalized)
    && normalized.predecessorTurnId === currentBinding?.turnId
    && normalized.preferences.provider === 'codex'
    && normalized.preferences.executionTargetKey === currentBinding?.targetKind
    && normalized.preferences.projectId === currentBinding?.projectId
    && normalized.preferences.projectPath === currentBinding?.projectPath
}

/**
 * Automatic advancement stays success-only. The one exception is a stop-and-send
 * the user explicitly confirmed, which already recorded its own approval for the
 * head prompt; a plain Stop must still pause the tail.
 */
export function queueMayAdvanceAfterRun({ completedSuccessfully = false, stopAndSendArmed = false } = {}) {
  return completedSuccessfully === true || stopAndSendArmed === true
}

/** This rejection proves the live instruction was not delivered and may remain FIFO. */
export function liveSteerWasSafelyRejected(error) {
  return error?.code === 'live_steer_unavailable' && error?.safeToRetry === true
}

/**
 * Automatic advancement is intentionally success-only. A persisted explicit
 * approval lets the user continue after reviewing an unsafe/failed predecessor;
 * it never retries that predecessor.
 */
export function queuedPromptGate(chat, entry) {
  if (!entry) return { state: 'empty', reason: null }
  if (entry.resumeApprovedAt) return { state: 'ready', reason: 'Explicitly approved after review.' }
  if (!entry.predecessorTurnId) return { state: 'ready', reason: null }

  const predecessor = chat?.messages?.find((message) =>
    message.role === 'user' && message.turnId === entry.predecessorTurnId)
  const reply = chat?.messages?.find((message) =>
    message.role === 'agent' && message.turnId === entry.predecessorTurnId)
  if (predecessor?.deliveryStatus === 'completed' && reply) {
    return { state: 'ready', reason: null }
  }
  if (!predecessor || predecessor.deliveryStatus === 'queued' || predecessor.deliveryStatus === 'pending') {
    return { state: 'waiting', reason: 'Waiting for the preceding turn to finish.' }
  }
  const labels = {
    failed: 'The preceding turn failed.',
    cancelled: 'The preceding turn was stopped.',
    interrupted: 'The preceding turn was interrupted and requires reconciliation.',
  }
  return {
    state: 'paused',
    reason: labels[predecessor.deliveryStatus]
      ?? 'The preceding turn did not reach a verified successful completion.',
  }
}

/** Plain-language queue copy for the conversation pane's compact status card. */
export function promptQueueStatusPresentation(gate, count, delivery) {
  const queueCount = Number.isSafeInteger(count) && count > 0 ? count : 0
  const messageLabel = queueCount === 1 ? 'message' : 'messages'
  const headline = `${queueCount} ${messageLabel} ${gate?.state === 'paused' ? 'paused' : 'queued'}`

  if (gate?.state === 'paused') {
    return {
      headline,
      detail: `${gate.reason ?? 'The previous turn did not finish successfully.'} Review possible partial project changes before continuing. Running the next message will not retry the previous turn.`,
      actionLabel: 'Run next message anyway',
    }
  }
  if (gate?.state === 'waiting') {
    // Live mid-turn delivery is Codex-only, so on every other provider the push
    // action is absent by design. Name that limit rather than leaving the user
    // to guess why a queued message cannot be promoted.
    const waitingDetail = 'It will run automatically after the current turn finishes successfully.'
    if (delivery && delivery.liveDeliverySupported === false) {
      const subject = typeof delivery.activeProviderName === 'string' && delivery.activeProviderName.trim()
        ? delivery.activeProviderName.trim()
        : 'This provider'
      // Name the destructive escape only when it is actually on screen, and
      // state what it costs so it can never read as a second Push now.
      const stopAndSend = delivery.stopAndSendAvailable === true
        ? ' Stop & send now ends the current turn instead, discarding its in-progress work.'
        : ''
      return {
        headline,
        detail: `${subject} cannot take a new instruction while a turn is running, so it will run automatically after the current turn finishes successfully.${stopAndSend}`,
        actionLabel: null,
      }
    }
    return {
      headline,
      detail: waitingDetail,
      actionLabel: null,
    }
  }
  if (gate?.state === 'ready') {
    return {
      headline,
      detail: 'Starting the next message.',
      actionLabel: null,
    }
  }
  return { headline, detail: '', actionLabel: null }
}

/** Only prior messages belong in the prompt/session cursor for this turn. */
export function transcriptMessagesBeforeTurn(messages, turnId) {
  const index = messages.findIndex((message) => message.role === 'user' && message.turnId === turnId)
  if (index < 0) return []
  return messages.slice(0, index).filter((message) => message.deliveryStatus !== 'transferred')
}

/** Keep logical transcript order even when later user prompts were pre-enqueued. */
export function insertAgentReplyBeforeLaterQueued(messages, turnId, reply) {
  const userIndex = messages.findIndex((message) => message.role === 'user' && message.turnId === turnId)
  if (userIndex < 0) return [...messages, reply]
  const insertionIndex = messages.findIndex((message, index) =>
    index > userIndex && message.role === 'user' && message.deliveryStatus === 'queued')
  if (insertionIndex < 0) return [...messages, reply]
  return [...messages.slice(0, insertionIndex), reply, ...messages.slice(insertionIndex)]
}

/** Move a Host-confirmed queued message into the active logical turn. */
export function promoteQueuedMessageToActiveTurn(messages, messageId, activeTurnId) {
  const messageIndex = messages.findIndex((message) =>
    message?.id === messageId && message.role === 'user' && message.deliveryStatus === 'queued')
  if (messageIndex < 0 || !nonEmptyString(activeTurnId)) return messages

  const replyVisible = messages.some((message) =>
    message.role === 'agent' && message.turnId === activeTurnId)
  const promoted = {
    ...messages[messageIndex],
    turnId: activeTurnId.trim(),
    deliveryStatus: replyVisible ? 'completed' : 'pending',
  }
  if (!replyVisible) {
    return messages.map((message, index) => index === messageIndex ? promoted : message)
  }

  const retained = messages.filter((_, index) => index !== messageIndex)
  const replyIndex = retained.findIndex((message) =>
    message.role === 'agent' && message.turnId === activeTurnId)
  return [
    ...retained.slice(0, replyIndex),
    promoted,
    ...retained.slice(replyIndex),
  ]
}

/** Apply only Host-authored live-turn readiness transitions. */
export function liveSteerReadyAfterEvent(current, event) {
  if (event?.type === 'notice' && event.code === 'live_steer_ready') return true
  if (event?.type === 'notice' && event.code === 'live_steer_closed') return false
  if (event?.type === 'finished') return false
  return current === true
}

/** Active-run submissions enter FIFO; live delivery is only an explicit Push now action. */
export function promptSubmissionMode({ hasActiveRun }) {
  return hasActiveRun ? 'queue' : 'run'
}

export function promptQueueComposerState({ sending, draft, canRun, liveSteering = false }) {
  const hasDraft = typeof draft === 'string' && Boolean(draft.trim())
  const state = {
    sendEnabled: hasDraft && Boolean(canRun),
    sendLabel: sending ? 'Queue message in this chat' : 'Send message',
    stopVisible: Boolean(sending),
    hint: sending ? '↵ queue · stop ends current only' : '↵ send · ⇧↵ new line',
  }
  // Without a live-steerable turn the composer carries an explicit "no live
  // send text" marker; while live steering is available the Push now control
  // owns that surface, so the composer state omits the field entirely.
  if (!liveSteering) state.sendText = null
  return state
}

// host/prompt-queue.test.mjs — the executable Host/renderer contract — reads
// these two guards as ambient globals, so publish them alongside the module
// exports. They are pure functions; publishing them carries no state.

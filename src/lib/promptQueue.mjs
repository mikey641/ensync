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
export function promptQueueStatusPresentation(gate, count) {
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
    return {
      headline,
      detail: 'It will run automatically after the current turn finishes successfully.',
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

/**
 * Offer live delivery only while the renderer has observed the exact local
 * Codex process start and has not yet observed its terminal event. A retained
 * Host job also covers provider startup and terminal cleanup, neither of which
 * has an active turn that can accept `turn/steer`.
 */
export function queuedPromptCanPushNow({ sending, liveSteeringReady, activeRun, entry }) {
  return Boolean(
    sending
    && liveSteeringReady
    && activeRun?.provider === 'codex'
    && activeRun.executionTarget === 'local'
    && activeRun.jobId
    && entry
    && entry.predecessorTurnId === activeRun.turnId
    && entry.preferences?.executionTargetKey === activeRun.executionTarget
    && entry.preferences?.projectId === activeRun.projectId
    && entry.preferences?.projectPath === activeRun.projectPath,
  )
}

/** Only prior messages belong in the prompt/session cursor for this turn. */
export function transcriptMessagesBeforeTurn(messages, turnId) {
  const index = messages.findIndex((message) => message.role === 'user' && message.turnId === turnId)
  if (index < 0) return []
  return messages.slice(0, index)
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

export function promptQueueComposerState({ sending, draft, canRun, liveSteering = false }) {
  const hasDraft = typeof draft === 'string' && Boolean(draft.trim())
  return {
    sendEnabled: hasDraft && Boolean(canRun),
    sendLabel: sending
      ? liveSteering
        ? 'Steer the active Codex turn'
        : 'Queue message in this chat'
      : 'Send message',
    stopVisible: Boolean(sending),
    hint: sending
      ? liveSteering
        ? '↵ steer now · stop ends turn'
        : '↵ queue · stop ends current only'
      : '↵ send · ⇧↵ new line',
  }
}

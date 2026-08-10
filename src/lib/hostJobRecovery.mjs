const HOST_JOB_TURN_PATTERN = /^turn-[A-Za-z0-9_-]{8,96}$/
const SUPPORTED_CHAT_PROVIDERS = Object.freeze(['codex', 'claude', 'droid'])

function providerOrder(chatProvider) {
  return SUPPORTED_CHAT_PROVIDERS.includes(chatProvider)
    ? [chatProvider, ...SUPPORTED_CHAT_PROVIDERS.filter((provider) => provider !== chatProvider)]
    : [...SUPPORTED_CHAT_PROVIDERS]
}

/**
 * Host job IDs are deterministic idempotency keys. If a renderer snapshot was
 * incorrectly finalized while the detached Host kept running, probe only the
 * exact recent chat/turn/provider keys which this renderer could have created.
 * This never starts or replays a provider request.
 */
export function runningHostJobCandidates(chats, options = {}) {
  const maximumTurns = Number.isSafeInteger(options.maximumTurns) && options.maximumTurns > 0
    ? options.maximumTurns
    : 12
  const maximumAttempts = Number.isSafeInteger(options.maximumAttempts) && options.maximumAttempts > 0
    ? options.maximumAttempts
    : SUPPORTED_CHAT_PROVIDERS.length
  const candidates = []
  const seen = new Set()

  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat || typeof chat.id !== 'string' || !Array.isArray(chat.messages)) continue
    const turns = chat.messages
      .filter((message) => message?.role === 'user'
        && typeof message.turnId === 'string'
        && HOST_JOB_TURN_PATTERN.test(message.turnId)
        && ['pending', 'failed', 'interrupted'].includes(message.deliveryStatus))
      .slice(-maximumTurns)
    for (const message of turns) {
      for (const provider of providerOrder(chat.provider)) {
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
          const jobId = `job-${message.turnId}-${provider}-${attempt}`
          if (seen.has(jobId)) continue
          seen.add(jobId)
          candidates.push({ chatId: chat.id, turnId: message.turnId, provider, attempt, jobId })
        }
      }
    }
  }
  return candidates
}

/** Restore only renderer presentation/reconnect state for an already-running,
 * exact Host job. The buffered Host event stream remains authoritative. */
export function adoptReconnectableHostJobState(state, recovery) {
  const { candidate, job, projectPath, executionTarget } = recovery
  const chat = (Array.isArray(state.chats) ? state.chats : [])
    .find((item) => item?.id === candidate.chatId)
  if (!chat || !['running', 'completed'].includes(job?.state) || job?.id !== candidate.jobId) return null

  const inFlightRun = {
    turnId: candidate.turnId,
    provider: candidate.provider,
    sizeTier: chat.sizeTier ?? null,
    executionTarget,
    attemptedProviders: [candidate.provider],
    fallbackReason: null,
    providerProcessStarted: job.providerProcessStarted === true,
    startedAt: job.startedAt,
    gitBefore: null,
    jobId: job.id,
    lastEventSequence: 0,
    projectId: chat.projectId,
    projectPath,
    continuityStateRequired: candidate.attempt > 1,
    gitReason: 'Rediscovered from the exact still-running Ensync Host job after renderer state loss.',
  }
  const chats = state.chats.map((item) => item.id === candidate.chatId ? {
    ...item,
    subtitle: 'Working now',
    messages: item.messages.map((message) => message.role === 'user' && message.turnId === candidate.turnId
      ? { ...message, deliveryStatus: 'pending' }
      : message),
    continuation: item.continuation?.turnId === candidate.turnId ? undefined : item.continuation,
  } : item)

  return {
    chats,
    chatErrors: { ...(state.chatErrors ?? {}), [candidate.chatId]: null },
    chatExecutionEvents: { ...(state.chatExecutionEvents ?? {}), [candidate.chatId]: [] },
    inFlightRuns: { ...(state.inFlightRuns ?? {}), [candidate.chatId]: inFlightRun },
    inFlightRun,
  }
}

const HOST_JOB_TURN_PATTERN = /^turn-[A-Za-z0-9_-]{8,96}$/
// The deterministic probe covers only the two structured local CLI runners a
// renderer routes retained Host jobs through, and only the attempts it
// actually creates (the initial dispatch plus one automatic fallback). This
// keeps the candidate set small, bounded, and free of identities this
// renderer could never have started.
const PROBED_JOB_PROVIDERS = Object.freeze(['codex', 'claude'])
const DEFAULT_MAXIMUM_ATTEMPTS = 2
const NATIVE_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TRANSCRIPT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

function nonEmptyString(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function exactOccupiedAdoption(state, recovery, chat) {
  const occupied = recovery?.occupied
  if (!occupied) return true
  const owner = occupied.owner
  const candidate = recovery.candidate
  const job = recovery.job
  if (!owner || !candidate || !job
    || !NATIVE_WORKSPACE_ID_PATTERN.test(owner.nativeWorkspaceId ?? '')
    || !NATIVE_WORKSPACE_ID_PATTERN.test(occupied.replacementWorkspaceId ?? '')
    || owner.ownerJobId !== candidate.jobId
    || owner.turnId !== candidate.turnId
    || owner.provider !== candidate.provider
    || owner.targetKind !== 'local'
    || owner.projectId !== chat.projectId
    || owner.projectPath !== recovery.projectPath
    || owner.chatId !== candidate.chatId
    || !TRANSCRIPT_FINGERPRINT_PATTERN.test(owner.predecessorTranscriptFingerprint ?? '')
    || owner.predecessorTranscriptFingerprint !== recovery.predecessorTranscriptFingerprint
    || job.id !== owner.ownerJobId
    || job.kind !== 'local'
    || recovery.executionTarget !== 'local'
    || !HOST_JOB_TURN_PATTERN.test(candidate.turnId)
    || !nonEmptyString(candidate.provider, 64)
    || !Number.isSafeInteger(candidate.attempt)
    || candidate.attempt < 1
    || candidate.jobId !== `job-${candidate.turnId}-${candidate.provider}-${candidate.attempt}`
    || state.inFlightRuns?.[candidate.chatId]) return false

  const predecessorTurns = chat.messages.filter((message) => message?.role === 'user'
    && message.turnId === candidate.turnId
    && ['pending', 'failed', 'interrupted'].includes(message.deliveryStatus))
  return predecessorTurns.length === 1
    && !chat.messages.some((message) => message?.role === 'agent' && message.turnId === candidate.turnId)
}

function canonicalAttachment(attachment) {
  return attachment && typeof attachment === 'object'
    && typeof attachment.name === 'string'
    && typeof attachment.path === 'string'
    ? { name: attachment.name, path: attachment.path }
    : null
}

/**
 * Serialize only the stable, provider-visible transcript identity. Presentation
 * timestamps and the active turn's delivery state can legitimately change
 * during crash recovery, while predecessor failed/cancelled/interrupted labels
 * change prompt semantics and remain bound. Later queued messages are excluded.
 */
export function canonicalPredecessorTranscript(messages, turnId) {
  if (!Array.isArray(messages) || !HOST_JOB_TURN_PATTERN.test(turnId ?? '')) return null
  const targetIndexes = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === 'user' && message.turnId === turnId) targetIndexes.push(index)
  }
  if (targetIndexes.length !== 1
    || messages.some((message) => message?.role === 'agent' && message.turnId === turnId)) return null

  const predecessor = []
  const targetIndex = targetIndexes[0]
  for (const [index, message] of messages.slice(0, targetIndex + 1).entries()) {
    if (!message || !['user', 'agent'].includes(message.role)
      || typeof message.id !== 'string'
      || typeof message.content !== 'string') return null
    const attachments = []
    for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
      const canonical = canonicalAttachment(attachment)
      if (!canonical) return null
      attachments.push(canonical)
    }
    predecessor.push({
      role: message.role,
      id: message.id,
      turnId: typeof message.turnId === 'string' ? message.turnId : null,
      provider: typeof message.provider === 'string' ? message.provider : null,
      content: message.content,
      attachments,
      deliveryCategory: message.role === 'user' && index < targetIndex
        ? ['failed', 'cancelled', 'interrupted'].includes(message.deliveryStatus)
          ? message.deliveryStatus
          : 'normal'
        : null,
    })
  }
  return JSON.stringify(predecessor)
}

/** Browser-safe SHA-256 binding; unavailable Web Crypto leaves adoption closed. */
export async function predecessorTranscriptFingerprint(messages, turnId) {
  const canonical = canonicalPredecessorTranscript(messages, turnId)
  const subtle = globalThis.crypto?.subtle
  if (canonical === null || !subtle || typeof TextEncoder !== 'function') return null
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function fingerprintAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error('Run stopped before transcript binding completed.')
  error.name = 'AbortError'
  return error
}

/**
 * Gate every Host-starting side effect behind both fingerprint settlement and
 * the latest cancellation state. Promise.race observes a digest that settles
 * after abort, so its late rejection never becomes unhandled.
 */
export async function beginRunAfterPredecessorFingerprint(fingerprintPromise, signal, begin) {
  if (signal?.aborted) throw fingerprintAbortError(signal)
  if (!signal || typeof signal.addEventListener !== 'function') {
    return begin(await Promise.resolve(fingerprintPromise))
  }
  let abort
  const aborted = new Promise((_resolve, reject) => {
    abort = () => reject(fingerprintAbortError(signal))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    const fingerprint = await Promise.race([Promise.resolve(fingerprintPromise), aborted])
    if (signal.aborted) throw fingerprintAbortError(signal)
    return begin(fingerprint)
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Only the authenticated HTTP status, not a possibly stale error code, proves absence. */
export function shouldSuppressOccupiedJobProbe(status) {
  return status === 404
}

/**
 * Coordinates effect-owned timers without allowing an unrelated state update
 * to cancel a sibling request after it has started.
 */
export function createOccupiedJobProbeCoordinator() {
  const current = new Map()
  return {
    reserve(ownerKey) {
      if (!nonEmptyString(ownerKey, 1024) || current.has(ownerKey)) return null
      const record = { phase: 'scheduled' }
      current.set(ownerKey, record)
      const isCurrent = () => current.get(ownerKey) === record
      return {
        start() {
          if (!isCurrent() || record.phase !== 'scheduled') return false
          record.phase = 'running'
          return true
        },
        isCurrent,
        finish() {
          if (!isCurrent()) return false
          current.delete(ownerKey)
          return true
        },
      }
    },
    invalidateAll() {
      current.clear()
    },
  }
}

function providerOrder(chatProvider) {
  return PROBED_JOB_PROVIDERS.includes(chatProvider)
    ? [chatProvider, ...PROBED_JOB_PROVIDERS.filter((provider) => provider !== chatProvider)]
    : [...PROBED_JOB_PROVIDERS]
}

/**
 * Returns every exact local occupied owner that remains probeable. Timer
 * cancellation and transient failures do not enter the suppression set; only
 * a genuine missing-job response does.
 */
export function retryableOccupiedJobProbes(occupiedRuns, missingExactOwnerKeys = []) {
  const missing = new Set(missingExactOwnerKeys)
  if (!occupiedRuns || typeof occupiedRuns !== 'object' || Array.isArray(occupiedRuns)) return []
  return Object.entries(occupiedRuns).flatMap(([chatId, owner]) => {
    if (!nonEmptyString(chatId, 256)
      || !nonEmptyString(owner?.ownerJobId, 256)
      || !nonEmptyString(owner?.turnId, 256)
      || owner.targetKind !== 'local') return []
    const ownerKey = `${chatId}\0${owner.ownerJobId}`
    return missing.has(ownerKey) ? [] : [{ chatId, owner, ownerKey }]
  })
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
    : DEFAULT_MAXIMUM_ATTEMPTS
  const excludedChatIds = new Set(Array.isArray(options.excludedChatIds)
    ? options.excludedChatIds.filter((chatId) => typeof chatId === 'string')
    : [])
  const candidates = []
  const seen = new Set()

  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat || typeof chat.id !== 'string' || excludedChatIds.has(chat.id)
      || !Array.isArray(chat.messages)) continue
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
  if (!chat || !['running', 'completed'].includes(job?.state) || job?.id !== candidate.jobId
    || !exactOccupiedAdoption(state, recovery, chat)) return null

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

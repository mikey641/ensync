function recordCreatedAt(record) {
  const timestamp = Date.parse(record?.createdAt ?? record?.updatedAt ?? '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

function uniqueRecords(status) {
  const records = [
    ...(Array.isArray(status?.records) ? status.records : []),
    status?.current,
    status?.production,
    status?.pending,
  ]
  const seen = new Set()
  return records.filter((record) => {
    if (!record || typeof record.id !== 'string' || seen.has(record.id)) return false
    seen.add(record.id)
    return true
  })
}

export function scopeDeliveryStatusForBranch(status, sourceBranch) {
  if (!status || typeof sourceBranch !== 'string' || !sourceBranch) {
    return { current: null, production: null, pending: null, records: [] }
  }
  const records = uniqueRecords(status)
    .filter((record) => Array.isArray(record.sourceBranches) && record.sourceBranches.includes(sourceBranch))
    .sort((left, right) => Number(Boolean(left.replacementCommitSha)) - Number(Boolean(right.replacementCommitSha))
      || recordCreatedAt(right) - recordCreatedAt(left))
  const production = records
    .filter((record) => record.state === 'production')
    .sort((left, right) => {
      const leftTime = Date.parse(left.productionAt ?? left.updatedAt ?? '')
      const rightTime = Date.parse(right.productionAt ?? right.updatedAt ?? '')
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
    })[0] ?? null
  const pending = records.find((record) => record.state !== 'production' && !record.replacementCommitSha) ?? null
  return {
    current: pending ?? production ?? records[0] ?? null,
    production,
    pending,
    records: records.slice(0, 10),
  }
}

function completedRunSavedPrefix(events) {
  if (!Array.isArray(events)) return null
  const notice = [...events].reverse().find((event) => (
    event?.type === 'notice'
    && ['automatic_landing_queued', 'delivery_saved_only'].includes(event.code)
  ))
  const match = notice?.message?.match(/\bat ([a-f0-9]{12,64})(?:\b|$)/i)
  return match?.[1]?.toLowerCase() ?? null
}

export function deliveryPromptContext(delivery, productionDelivery, messages, activeTurnId, events) {
  const trackedTurnIds = new Set([
    ...(Array.isArray(delivery?.turnIds) ? delivery.turnIds : []),
    ...(Array.isArray(productionDelivery?.turnIds) ? productionDelivery.turnIds : []),
  ])
  const activePrompt = typeof activeTurnId === 'string' && Array.isArray(messages)
    ? messages.find((message) => message?.role === 'user' && message?.turnId === activeTurnId) ?? null
    : null
  const latestPrompt = Array.isArray(messages)
    ? [...messages].reverse().find((message) => message?.role === 'user') ?? null
    : null
  // An active Host turn must lead over newer queued prompts. Once the turn
  // finishes, the latest user prompt remains the durable lead for this card.
  const prompt = activePrompt ?? latestPrompt
  const promptIsActive = typeof activeTurnId === 'string'
    && activeTurnId.length > 0
    && prompt?.turnId === activeTurnId
  const hasUnsavedActivePrompt = promptIsActive && !trackedTurnIds.has(activeTurnId)
  const journalTracksPrompt = Boolean(
    prompt?.turnId
    && Array.isArray(delivery?.turnIds)
    && delivery.turnIds.includes(prompt.turnId),
  )
  const latestAgent = Array.isArray(messages)
    ? [...messages].reverse().find((message) => message?.role === 'agent') ?? null
    : null
  const savedPrefix = completedRunSavedPrefix(events)
  // Rolling updates may leave an older detached Host without the turn ID even
  // though its chat-scoped completion stream and immutable commit agree. This
  // bridge uses only that exact local evidence; the upgraded Host persists the
  // same identity from the commit metadata on its next status read.
  const completedRunTracksPrompt = Boolean(
    !journalTracksPrompt
    && prompt?.turnId
    && prompt.deliveryStatus === 'completed'
    && latestAgent?.turnId === prompt.turnId
    && savedPrefix
    && typeof delivery?.savedSha === 'string'
    && delivery.savedSha.startsWith(savedPrefix),
  )
  const deliveryLinkProof = journalTracksPrompt
    ? 'journal'
    : completedRunTracksPrompt
      ? 'completed_run'
      : null
  return {
    prompt,
    promptIsActive,
    hasUnsavedActivePrompt,
    deliveryTracksPrompt: deliveryLinkProof !== null,
    deliveryLinkProof,
  }
}

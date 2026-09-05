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

function hasHostIdentityProof(record) {
  return ['captured', 'commit_trailer', 'legacy_job'].includes(record?.turnIdentityProof)
    && (record?.state !== 'production' || record?.productionAncestryVerified === true)
}

export function deliveryPromptContext(delivery, productionDelivery, messages, activeTurnId) {
  const trackedTurnIds = new Set([
    ...(hasHostIdentityProof(delivery) && Array.isArray(delivery?.turnIds) ? delivery.turnIds : []),
    ...(hasHostIdentityProof(productionDelivery) && Array.isArray(productionDelivery?.turnIds) ? productionDelivery.turnIds : []),
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
    && hasHostIdentityProof(delivery)
    && Array.isArray(delivery?.turnIds)
    && delivery.turnIds.includes(prompt.turnId),
  )
  const deliveryLinkProof = journalTracksPrompt ? 'host' : null
  return {
    prompt,
    promptIsActive,
    hasUnsavedActivePrompt,
    deliveryTracksPrompt: deliveryLinkProof !== null,
    deliveryLinkProof,
  }
}

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

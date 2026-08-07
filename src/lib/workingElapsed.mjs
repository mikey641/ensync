const SECOND_MS = 1_000

export function workingElapsedSeconds(startedAt, nowMs = Date.now()) {
  if (typeof startedAt !== 'string' || startedAt.trim() === '') return null
  const startedAtMs = Date.parse(startedAt)
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return null
  return Math.max(0, Math.floor((nowMs - startedAtMs) / SECOND_MS))
}

export function workingElapsedLabel({ running, startedAt, nowMs = Date.now() }) {
  if (!running) return null
  const elapsedSeconds = workingElapsedSeconds(startedAt, nowMs)
  if (elapsedSeconds === null) return null

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  const remainingSeconds = elapsedSeconds % 60
  const elapsedLabel = elapsedMinutes > 0
    ? `${elapsedMinutes}m ${remainingSeconds}s`
    : `${remainingSeconds}s`

  return `• Working (${elapsedLabel})`
}

export function nextWorkingElapsedDelay(startedAt, nowMs = Date.now()) {
  const startedAtMs = Date.parse(startedAt)
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return SECOND_MS
  const elapsedMs = Math.max(0, nowMs - startedAtMs)
  const remainder = elapsedMs % SECOND_MS
  return remainder === 0 ? SECOND_MS : SECOND_MS - remainder
}

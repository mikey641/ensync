const MAX_OVERLAPS = 50
const MAX_PATHS_PER_OVERLAP = 200
const MAX_PATH_LENGTH = 4_096
const MAX_TITLE_LENGTH = 80

function normalizedPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return null
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || /[\0\r\n]/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return normalized
}

function normalizedOverlap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.peerBranch !== 'string' || value.peerBranch.length === 0 || value.peerBranch.length > 256) return null
  if (!['detected', 'cleared'].includes(value.state) || !['active', 'unlanded'].includes(value.source)) return null
  if (!Array.isArray(value.paths) || value.paths.length > MAX_PATHS_PER_OVERLAP) return null
  if (!Number.isInteger(value.totalCount) || value.totalCount < 0 || value.totalCount > MAX_PATHS_PER_OVERLAP) return null
  const paths = [...new Set(value.paths.map(normalizedPath))]
  if (paths.includes(null)) return null
  paths.sort()
  if (value.state === 'detected' && (paths.length === 0 || value.totalCount < paths.length)) return null
  return {
    peerBranch: value.peerBranch,
    state: value.state,
    source: value.source,
    paths,
    totalCount: value.totalCount,
  }
}

/** Rebuild the currently active peer overlaps from the retained Host event journal. */
export function activeWorkspaceOverlaps(events) {
  if (!Array.isArray(events)) return []
  const active = new Map()
  for (const event of events) {
    if (!event || event.type !== 'notice') continue
    const overlap = normalizedOverlap(event.overlap)
    if (!overlap) continue
    if (overlap.state === 'cleared') {
      const current = active.get(overlap.peerBranch)
      if (!current || current.source === overlap.source) active.delete(overlap.peerBranch)
      continue
    }
    active.set(overlap.peerBranch, overlap)
    if (active.size > MAX_OVERLAPS) active.delete(active.keys().next().value)
  }
  return [...active.values()].sort((left, right) => left.peerBranch.localeCompare(right.peerBranch))
}

function knownTitle(branchTitles, branch) {
  const candidate = branchTitles instanceof Map ? branchTitles.get(branch) : branchTitles?.[branch]
  if (typeof candidate !== 'string') return null
  const title = candidate.replace(/\s+/g, ' ').trim()
  return title ? title.slice(0, MAX_TITLE_LENGTH) : null
}

function actorLabel(overlaps, branchTitles) {
  const titles = overlaps.map((overlap) => knownTitle(branchTitles, overlap.peerBranch)).filter(Boolean)
  if (overlaps.length === 1) return titles[0] ?? 'Another Ensync conversation'
  if (titles.length === overlaps.length && titles.length === 2) return `${titles[0]} and ${titles[1]}`
  if (titles.length > 0) {
    const others = overlaps.length - 1
    return `${titles[0]} and ${others} other Ensync conversation${others === 1 ? '' : 's'}`
  }
  return `${overlaps.length} other Ensync conversations`
}

/** Build bounded banner copy without placing another persistence layer in the renderer. */
export function workspaceOverlapSummary(overlaps, branchTitles = {}) {
  if (!Array.isArray(overlaps) || overlaps.length === 0) return null
  const paths = [...new Set(overlaps.flatMap((overlap) => overlap.paths))].sort()
  if (paths.length === 0) return null
  const visiblePaths = paths.slice(0, 3)
  const remainingCount = paths.length - visiblePaths.length
  const allActive = overlaps.every((overlap) => overlap.source === 'active')
  const allUnlanded = overlaps.every((overlap) => overlap.source === 'unlanded')
  const plural = overlaps.length > 1
  const verb = allActive
    ? plural ? 'are editing' : 'is editing'
    : allUnlanded
      ? plural ? 'have unlanded changes in' : 'has unlanded changes in'
      : plural ? 'are editing or have unlanded changes in' : 'is editing or has unlanded changes in'
  const pathCopy = `${visiblePaths.join(', ')}${remainingCount > 0 ? ` and ${remainingCount} other file${remainingCount === 1 ? '' : 's'}` : ''}`
  const message = `${actorLabel(overlaps, branchTitles)} ${verb} ${pathCopy}. Work can continue; Ensync will recheck before landing.`
  return {
    message,
    paths: visiblePaths,
    remainingCount,
    peerCount: overlaps.length,
  }
}

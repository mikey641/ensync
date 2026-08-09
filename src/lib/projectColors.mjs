export const PROJECT_COLORS = Object.freeze([
  '#2fb36c',
  '#3f83e0',
  '#e37931',
  '#9565d4',
  '#d0a11a',
  '#d65087',
  '#169bb5',
  '#d65555',
  '#169e8c',
  '#5f67d8',
  '#76a824',
  '#b64fc4',
])

function normalizedProjectIdentity(value) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

/**
 * Assigns a stable, theme-safe accent without persisting user-specific order.
 * FNV-1a avoids the frequent collisions produced by summing path characters.
 */
export function projectColor(identity) {
  const normalized = normalizedProjectIdentity(identity)
  let hash = 0x811c9dc5
  for (const character of normalized) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return PROJECT_COLORS[(hash >>> 0) % PROJECT_COLORS.length]
}

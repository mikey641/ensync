import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

export const WORKSPACE_RECOVERY_CHANNEL = 'ensync:workspace:get-recovery-candidate'
export const MAX_WORKSPACE_RECOVERY_BYTES = 8 * 1024 * 1024

function looksLikeWorkspaceEnvelope(encoded) {
  try {
    const value = JSON.parse(encoded)
    return Boolean(
      value
      && value.format === 'ensync-workspace'
      && value.version === 3
      && Number.isSafeInteger(value.revision)
      && typeof value.committedAt === 'string'
      && typeof value.checksum === 'string'
      && typeof value.payload === 'string',
    )
  } catch {
    return false
  }
}

/** Reads only an operator-selected recovery artifact, never Chromium storage. */
export function createWorkspaceRecoveryHandler({
  isAuthorized,
  identityForWebContents,
  recoveryFilePath,
  readFile = readFileSync,
  fileStat = statSync,
} = {}) {
  if (typeof isAuthorized !== 'function' || typeof identityForWebContents !== 'function') {
    throw new TypeError('Workspace recovery authorization is required.')
  }
  return async (event) => {
    if (!recoveryFilePath || !isAuthorized(event)) return null
    const identity = identityForWebContents(event.sender)
    if (identity?.kind !== 'canonical') return null
    const stat = fileStat(recoveryFilePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WORKSPACE_RECOVERY_BYTES) {
      throw new Error('The Ensync recovery artifact is missing or exceeds the recovery size limit.')
    }
    const encoded = readFile(recoveryFilePath, 'utf8')
    if (!looksLikeWorkspaceEnvelope(encoded)) throw new Error('The Ensync recovery artifact is not a v3 workspace snapshot.')
    return {
      id: createHash('sha256').update(encoded).digest('hex'),
      encoded,
    }
  }
}

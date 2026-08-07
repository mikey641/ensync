import {
  commitWorkspaceSnapshot,
  compactWorkspaceSnapshot,
  createWorkspaceSnapshotKeys,
  readWorkspaceSnapshot,
} from './workspacePersistence.mjs'
import {
  getNativeWorkspaceIdentity,
  isCanonicalWorkspace,
  workspaceStorageKey,
} from './nativeWorkspaceIdentity.mjs'
import { mergeRecoveredWorkspaceState } from './workspaceRecovery.mjs'

function candidateSnapshot(encoded) {
  return readWorkspaceSnapshot({
    getItem(key) { return key === 'ensync-workspace-snapshot-v3' ? encoded : null },
  })
}

/**
 * Opt-in native recovery. The main process exposes a candidate only when the
 * operator explicitly launches Ensync with ENSYNC_WORKSPACE_RECOVERY_FILE.
 * Selecting that process-scoped file is the authorization to merge it.
 */
export async function initializeNativeWorkspaceRecovery(target = globalThis, options = {}) {
  const identity = getNativeWorkspaceIdentity()
  const bridge = target?.ensyncDesktop
  if (!isCanonicalWorkspace(identity) || typeof bridge?.getWorkspaceRecoveryCandidate !== 'function') {
    return { status: 'unavailable' }
  }
  const candidate = await bridge.getWorkspaceRecoveryCandidate()
  if (!candidate) return { status: 'unavailable' }
  if (typeof candidate.id !== 'string' || !/^[0-9a-f]{64}$/i.test(candidate.id)
    || typeof candidate.encoded !== 'string') {
    throw new Error('Ensync received a malformed workspace recovery candidate.')
  }
  const recoveredSnapshot = candidateSnapshot(candidate.encoded)
  if (!recoveredSnapshot) throw new Error('The workspace recovery candidate failed checksum validation.')

  const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, identity))
  const currentSnapshot = readWorkspaceSnapshot(target.localStorage, { keys })
  const applied = Array.isArray(currentSnapshot?.state?.workspaceRecoveryIds)
    ? currentSnapshot.state.workspaceRecoveryIds
    : []
  if (applied.includes(candidate.id)) return { status: 'already_applied' }

  const result = mergeRecoveredWorkspaceState(currentSnapshot?.state ?? {}, recoveredSnapshot.state, {
    now: () => recoveredSnapshot.committedAt,
  })
  if (result.summary.addedChats === 0 && result.summary.addedProjects === 0 && result.summary.addedTabs === 0) {
    return { status: 'already_present', summary: result.summary }
  }
  const confirmRecovery = options.confirmRecovery ?? (() => true)
  if (!await confirmRecovery(result.summary)) return { status: 'declined', summary: result.summary }

  const state = {
    ...result.state,
    workspaceRecoveryIds: [...new Set([...applied, candidate.id])],
  }
  const commit = commitWorkspaceSnapshot(target.localStorage, compactWorkspaceSnapshot(state), { keys })
  return { status: 'applied', summary: result.summary, commit }
}

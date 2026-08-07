export const NATIVE_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const CANONICAL_WORKSPACE = Object.freeze({ id: null, kind: 'canonical' })
const WORKSPACE_IDENTITY_CHANNEL = 'ensync:workspace:get-identity'
const MISSING_HANDLER_MESSAGES = new Set([
  `No handler registered for '${WORKSPACE_IDENTITY_CHANNEL}'`,
  `Error invoking remote method '${WORKSPACE_IDENTITY_CHANNEL}': No handler registered for '${WORKSPACE_IDENTITY_CHANNEL}'`,
  `Error invoking remote method '${WORKSPACE_IDENTITY_CHANNEL}': Error: No handler registered for '${WORKSPACE_IDENTITY_CHANNEL}'`,
])
let currentWorkspace = CANONICAL_WORKSPACE
let retainedWorkspaceIds = Object.freeze([])

export function isNativeWorkspaceIdentity(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && NATIVE_WORKSPACE_ID_PATTERN.test(value.id)
    && (value.kind === 'canonical' || value.kind === 'isolated'),
  )
}

function normalizeRetainedWorkspaceIds(value) {
  if (!Array.isArray(value) || value.length > 32) return null
  const result = value.map((id) => typeof id === 'string' ? id.toLowerCase() : '')
  return result.every((id) => NATIVE_WORKSPACE_ID_PATTERN.test(id)) && new Set(result).size === result.length
    ? result
    : null
}

export function removeAbandonedNativeWorkspaceStorage(storage, retainedIds) {
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function'
    || typeof storage.removeItem !== 'function') return 0
  const retained = new Set(retainedIds)
  const keysToRemove = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    const match = typeof key === 'string'
      ? /^ensync-native-workspace:([0-9a-f-]{36}):/.exec(key)
      : null
    if (match && NATIVE_WORKSPACE_ID_PATTERN.test(match[1]) && !retained.has(match[1].toLowerCase())) {
      keysToRemove.push(key)
    }
  }
  for (const key of keysToRemove) storage.removeItem(key)
  return keysToRemove.length
}

export function isMissingWorkspaceIdentityHandlerError(error) {
  return MISSING_HANDLER_MESSAGES.has(error instanceof Error ? error.message : String(error ?? ''))
}

async function invokeWorkspaceIdentityWithCompatibility(bridge, {
  missingHandlerAttempts = 3,
  missingHandlerRetryMs = 75,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const attempts = Number.isSafeInteger(missingHandlerAttempts) && missingHandlerAttempts > 0
    ? missingHandlerAttempts
    : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { identity: await bridge.getWorkspaceIdentity(), legacyMain: false }
    } catch (error) {
      if (!isMissingWorkspaceIdentityHandlerError(error)) throw error
      if (attempt === attempts) return { identity: null, legacyMain: true }
      await wait(missingHandlerRetryMs)
    }
  }
  return { identity: null, legacyMain: true }
}

/**
 * Browser development keeps the historical canonical storage keys. The native
 * shell must provide an authenticated identity before React reads storage.
 */
export async function initializeNativeWorkspaceIdentity(target = globalThis, compatibilityOptions) {
  const bridge = target?.ensyncDesktop
  if (!bridge || typeof bridge.getWorkspaceIdentity !== 'function') {
    const userAgent = typeof target?.navigator?.userAgent === 'string' ? target.navigator.userAgent : ''
    if (/\bElectron\//i.test(userAgent)) {
      throw new Error('This Ensync window is running an older native bridge. Quit Ensync completely and reopen it before continuing.')
    }
    currentWorkspace = CANONICAL_WORKSPACE
    retainedWorkspaceIds = Object.freeze([])
    return currentWorkspace
  }

  const { identity, legacyMain } = await invokeWorkspaceIdentityWithCompatibility(bridge, compatibilityOptions)
  if (legacyMain) {
    throw new Error('This Ensync window could not obtain a native workspace identity. Quit Ensync completely and reopen it before continuing.')
  }
  const retainedIds = normalizeRetainedWorkspaceIds(identity?.retainedWorkspaceIds)
  if (!isNativeWorkspaceIdentity(identity) || !retainedIds || !retainedIds.includes(identity.id.toLowerCase())) {
    throw new Error('Ensync could not verify this native window workspace.')
  }
  // Retired UUID namespaces remain untouched for recovery. A newly generated
  // isolated identity cannot read them, so clean-window behavior does not need
  // destructive renderer-side localStorage cleanup.
  currentWorkspace = Object.freeze({ id: identity.id.toLowerCase(), kind: identity.kind })
  retainedWorkspaceIds = Object.freeze([...retainedIds])
  return currentWorkspace
}

export function getNativeWorkspaceIdentity() {
  return currentWorkspace
}

/** Shell-authenticated identities which are still eligible for relaunch. */
export function getRetainedNativeWorkspaceIds() {
  return [...retainedWorkspaceIds]
}

export function isCanonicalWorkspace(identity = currentWorkspace) {
  return identity?.kind === 'canonical'
}

/** Derive keys only from a validated shell-issued ID; never accept a raw key. */
export function workspaceStorageKey(baseKey, identity = currentWorkspace) {
  if (typeof baseKey !== 'string' || !baseKey) throw new TypeError('A base storage key is required.')
  if (identity?.kind === 'canonical') return baseKey
  if (!isNativeWorkspaceIdentity(identity)) throw new TypeError('A verified native workspace identity is required.')
  return `ensync-native-workspace:${identity.id}:${baseKey}`
}

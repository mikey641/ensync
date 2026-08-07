export type NativeWorkspaceIdentity = {
  id: string | null
  kind: 'canonical' | 'isolated'
}

export const NATIVE_WORKSPACE_ID_PATTERN: RegExp
export function isNativeWorkspaceIdentity(value: unknown): value is { id: string; kind: NativeWorkspaceIdentity['kind'] }
export function isMissingWorkspaceIdentityHandlerError(error: unknown): boolean
export function initializeNativeWorkspaceIdentity(target?: unknown, compatibilityOptions?: {
  missingHandlerAttempts?: number
  missingHandlerRetryMs?: number
  wait?: (milliseconds: number) => Promise<void>
}): Promise<NativeWorkspaceIdentity>
export function removeAbandonedNativeWorkspaceStorage(
  storage: Pick<Storage, 'length' | 'key' | 'removeItem'>,
  retainedIds: string[],
): number
export function getNativeWorkspaceIdentity(): NativeWorkspaceIdentity
export function getRetainedNativeWorkspaceIds(): string[]
export function isCanonicalWorkspace(identity?: NativeWorkspaceIdentity): boolean
export function workspaceStorageKey(baseKey: string, identity?: NativeWorkspaceIdentity): string

export const ACCOUNT_WORKSPACE_FORMAT: 'ensync-account-conversations'
export const ACCOUNT_WORKSPACE_VERSION: 1

export type AccountWorkspace = {
  format: typeof ACCOUNT_WORKSPACE_FORMAT
  version: typeof ACCOUNT_WORKSPACE_VERSION
  chats: Array<Record<string, unknown>>
  projects: Array<Record<string, unknown>>
}

export function prepareAccountWorkspace(state: Record<string, unknown>): AccountWorkspace
export function isAccountWorkspace(value: unknown): value is AccountWorkspace
export function mergeAccountWorkspace<T extends Record<string, unknown>>(
  localState: T,
  remoteValue: unknown,
): { state: T; importedChats: number; totalChats: number }


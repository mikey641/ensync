export const ACCOUNT_WORKSPACE_FORMAT: 'ensync-account-conversations'
export const ACCOUNT_WORKSPACE_VERSION: 3

export type AccountWorkspaceSettings = {
  placement: 'adjacent' | 'end'
  conversationLayout: 'tabs' | 'split'
  autoFallback: boolean
  autoContextSkill: boolean
  fallbackProviderOrder: string[]
  display: {
    theme: 'system' | 'light' | 'dark'
    textSize: 'comfortable' | 'large'
    completionIndicator: 'dot' | 'header' | 'tab'
  }
  agentUpdates: {
    mode: 'manual' | 'remind' | 'automatic'
    lastReminderAt: string | null
    lastMaintenanceAt: string | null
  }
}

export type AccountWorkspace = {
  format: typeof ACCOUNT_WORKSPACE_FORMAT
  version: typeof ACCOUNT_WORKSPACE_VERSION
  chats: Array<Record<string, unknown>>
  projects: Array<Record<string, unknown>>
  chatSessions: Record<string, Record<string, unknown>>
  inFlightRuns: Record<string, Record<string, unknown>>
  chatExecutionEvents: Record<string, Array<Record<string, unknown>>>
  settings: AccountWorkspaceSettings
}

export function prepareAccountWorkspace(state: Record<string, unknown>): AccountWorkspace
export function isAccountWorkspace(value: unknown): value is AccountWorkspace
export function accountWorkspaceHasSettings(value: unknown): boolean
export function mergeAccountWorkspace<T extends Record<string, unknown>>(
  localState: T,
  remoteValue: unknown,
  options?: { preferLocalSettings?: boolean },
): { state: T; importedChats: number; totalChats: number }

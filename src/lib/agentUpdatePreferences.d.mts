export type AgentUpdateMode = 'manual' | 'remind' | 'automatic'

export type AgentUpdatePreferences = {
  mode: AgentUpdateMode
  lastReminderAt: string | null
  lastMaintenanceAt: string | null
}

export const AGENT_UPDATE_PREFERENCES_KEY: string
export const AGENT_UPDATE_INTERVAL_MS: number
export function normalizeAgentUpdatePreferences(value: unknown): AgentUpdatePreferences
export function readAgentUpdatePreferences(storage?: Pick<Storage, 'getItem'> | null): AgentUpdatePreferences
export function writeAgentUpdatePreferences(storage: Pick<Storage, 'setItem'> | null | undefined, value: unknown): AgentUpdatePreferences
export function agentUpdateDue(preferences: unknown, now?: number): boolean
export function acknowledgeAgentUpdateReminder(preferences: unknown, at?: string): AgentUpdatePreferences
export function recordAgentUpdateMaintenance(preferences: unknown, at?: string): AgentUpdatePreferences

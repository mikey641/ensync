export type CompletionNotificationMode = 'off' | 'ringtone' | 'speech'

export type CompletionNotificationSettings = {
  mode: CompletionNotificationMode
  speechText: string
  voiceId: string | null
}

export const COMPLETION_NOTIFICATIONS_STORAGE_KEY: string
export const DEFAULT_COMPLETION_NOTIFICATION_SETTINGS: Readonly<CompletionNotificationSettings>
export function normalizeCompletionNotificationSettings(value: unknown): CompletionNotificationSettings
export function readCompletionNotificationSettings(storage?: Pick<Storage, 'getItem'>): CompletionNotificationSettings
export function writeCompletionNotificationSettings(
  settings: CompletionNotificationSettings,
  storage?: Pick<Storage, 'setItem'>,
): CompletionNotificationSettings
export function initializeCompletionNotificationPreferences(target?: typeof globalThis): Promise<CompletionNotificationSettings>
export function saveCompletionNotificationPreferences(
  settings: CompletionNotificationSettings,
  target?: typeof globalThis,
): CompletionNotificationSettings

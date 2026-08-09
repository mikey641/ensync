/// <reference types="vite/client" />

interface Window {
  ensyncDesktop?: {
    getPathForFile?: (file: File) => string
    getWorkspaceIdentity?: () => Promise<{
      id: string
      kind: 'canonical' | 'isolated'
      retainedWorkspaceIds: string[]
    } | null>
    getWorkspaceRecoveryCandidate?: () => Promise<{ id: string; encoded: string } | null>
    getCodexConversationImport?: () => Promise<object | null>
    getRecentProjects?: () => Promise<{ projects: Array<{ name: string; path: string; host: 'local' }> } | null>
    migrateRecentProjects?: (projects: Array<{ name: string; path: string; host: 'local' }>) => Promise<{ projects: Array<{ name: string; path: string; host: 'local' }> } | null>
    rememberRecentProject?: (project: { name: string; path: string; host: 'local' }) => Promise<{ projects: Array<{ name: string; path: string; host: 'local' }> } | null>
    onRecentProjectsChanged?: (callback: (state: { projects: Array<{ name: string; path: string; host: 'local' }> }) => void) => () => void
    getDevicePreferences?: () => Promise<{
      completionNotifications: {
        mode: 'off' | 'ringtone' | 'speech'
        speechText: string
        voiceId: string | null
      } | null
    } | null>
    setCompletionNotificationPreferences?: (settings: {
      mode: 'off' | 'ringtone' | 'speech'
      speechText: string
      voiceId: string | null
    }) => Promise<{
      completionNotifications: {
        mode: 'off' | 'ringtone' | 'speech'
        speechText: string
        voiceId: string | null
      }
    } | null>
  }
}

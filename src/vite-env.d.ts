/// <reference types="vite/client" />

interface Window {
  ensyncDesktop?: {
    getPathForFile?: (file: File) => string
    chooseChatFiles?: () => Promise<
      | { status: 'selected'; files: Array<{ name: string; path: string }> }
      | { status: 'cancelled' }
      | { status: 'error'; message: string }
    >
    getWorkspaceIdentity?: () => Promise<{
      id: string
      kind: 'canonical' | 'isolated'
      retainedWorkspaceIds: string[]
      retainedWorkspaces: Array<{ id: string; kind: 'canonical' | 'isolated' }>
      projectLaunch?: {
        projectId: string
        projectPath: string
        sourceWorkspace: { id: string; kind: 'canonical' | 'isolated' }
      }
    } | null>
    focusWorkspace?: (request: {
      workspaceId: string
      projectId: string
      projectPath: string
    }) => Promise<boolean>
    openProjectWorkspace?: (request: {
      projectId: string
      projectPath: string
    }) => Promise<boolean>
    onWorkspaceProjectFocus?: (callback: (request: {
      projectId: string
      projectPath: string
    }) => void) => () => void
    getWorkspaceRecoveryCandidate?: () => Promise<{ id: string; encoded: string } | null>
    getCodexConversationImport?: () => Promise<object | null>
    getRecentProjects?: () => Promise<{ projects: Array<{ name: string; path: string; host: 'local' }> } | null>
    migrateRecentProjects?: (projects: Array<{ name: string; path: string; host: 'local' }>) => Promise<{ projects: Array<{ name: string; path: string; host: 'local' }> } | null>
    rememberRecentProject?: (project: { name: string; path: string; host: 'local' }) => Promise<{ projects: Array<{ name: string; path: string; host: 'local' }> } | null>
    onRecentProjectsChanged?: (callback: (state: { projects: Array<{ name: string; path: string; host: 'local' }> }) => void) => () => void
    openLocalFile?: (path: string) => Promise<{
      status: 'opened' | 'revealed' | 'missing' | 'error'
      message?: string
    } | null>
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

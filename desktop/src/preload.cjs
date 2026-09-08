'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const PROJECT_FOLDER_PICKER_CHANNEL = 'ensync:project-folder:choose'
const CHAT_FILE_PICKER_CHANNEL = 'ensync:chat-files:choose'
const UPDATE_STATE_CHANNEL = 'ensync:updates:state'
const UPDATE_GET_STATE_CHANNEL = 'ensync:updates:get-state'
const UPDATE_CHECK_CHANNEL = 'ensync:updates:check'
const UPDATE_DOWNLOAD_CHANNEL = 'ensync:updates:download'
const UPDATE_CANCEL_CHANNEL = 'ensync:updates:cancel'
const UPDATE_APPLY_CHANNEL = 'ensync:updates:apply'
const UPDATE_QUIT_AND_INSTALL_CHANNEL = 'ensync:updates:quit-and-install'
const UPDATE_SET_CHANNEL_CHANNEL = 'ensync:updates:set-channel'
const UPDATE_SET_MODE_CHANNEL = 'ensync:updates:set-mode'
const WORKSPACE_IDENTITY_CHANNEL = 'ensync:workspace:get-identity'
const WORKSPACE_FOCUS_CHANNEL = 'ensync:workspace:focus'
const WORKSPACE_OPEN_PROJECT_CHANNEL = 'ensync:workspace:open-project'
const WORKSPACE_OPEN_PATH_CHANNEL = 'ensync:workspace:open-path'
const WORKSPACE_PROJECT_FOCUS_CHANNEL = 'ensync:workspace:focus-project'
const ACTIVE_RUNS_PUBLISH_CHANNEL = 'ensync:workspace:publish-active-runs'
const ACTIVE_RUN_MATCH_CHANNEL = 'ensync:workspace:match-active-run'
const ACTIVE_RUN_CLAIM_CHANNEL = 'ensync:workspace:claim-active-run'
const ACTIVE_RUN_CLAIM_FINALIZE_CHANNEL = 'ensync:workspace:finalize-active-run-claim'
const ACTIVE_RUN_CLAIM_RELEASE_CHANNEL = 'ensync:workspace:release-active-run-claim'
const QUEUED_MESSAGE_HANDOFF_CHANNEL = 'ensync:workspace:handoff-queued-message'
const QUEUED_MESSAGE_HANDOFF_ACK_CHANNEL = 'ensync:workspace:queued-message-handoff-ack'
const QUEUED_MESSAGE_HANDOFF_EVENT_CHANNEL = 'ensync:workspace:queued-message-handoff'
const WORKSPACE_RECOVERY_CHANNEL = 'ensync:workspace:get-recovery-candidate'
const CODEX_CONVERSATION_IMPORT_CHANNEL = 'ensync:workspace:get-codex-conversation-import'
const RECENT_PROJECTS_GET_CHANNEL = 'ensync:recent-projects:get'
const RECENT_PROJECTS_MIGRATE_CHANNEL = 'ensync:recent-projects:migrate'
const RECENT_PROJECTS_REMEMBER_CHANNEL = 'ensync:recent-projects:remember'
const RECENT_PROJECTS_CHANGED_CHANNEL = 'ensync:recent-projects:changed'
const LOCAL_FILE_OPEN_CHANNEL = 'ensync:shell:open-local-file'
const DEVICE_PREFERENCES_GET_CHANNEL = 'ensync:device-preferences:get'
const COMPLETION_NOTIFICATION_PREFERENCES_SET_CHANNEL = 'ensync:device-preferences:set-completion-notifications'
const SYNC_SERVICE_URL_SET_CHANNEL = 'ensync:device-preferences:set-sync-service-url'
const TITLEBAR_APPEARANCE_CHANNEL = 'ensync:window:set-titlebar-appearance'
const CLOUDFLARE_TUNNEL_STATUS_CHANNEL = 'ensync:tunnel:status'
const CLOUDFLARE_TUNNEL_SETUP_CHANNEL = 'ensync:tunnel:setup'
const CLOUDFLARE_TUNNEL_START_CHANNEL = 'ensync:tunnel:start'
const CLOUDFLARE_TUNNEL_STOP_CHANNEL = 'ensync:tunnel:stop'
const CLOUDFLARE_TUNNEL_CLEAR_CHANNEL = 'ensync:tunnel:clear'
const CLOUDFLARE_TUNNEL_QUICK_START_CHANNEL = 'ensync:tunnel:quick-start'
const CLOUDFLARE_TUNNEL_QUICK_STOP_CHANNEL = 'ensync:tunnel:quick-stop'

contextBridge.exposeInMainWorld('ensyncDesktop', Object.freeze({
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getWorkspaceIdentity: () => ipcRenderer.invoke(WORKSPACE_IDENTITY_CHANNEL),
  publishActiveRuns: (entries) => ipcRenderer.invoke(ACTIVE_RUNS_PUBLISH_CHANNEL, entries),
  matchesActiveRun: (request) => ipcRenderer.invoke(ACTIVE_RUN_MATCH_CHANNEL, request),
  claimActiveRun: (request) => ipcRenderer.invoke(ACTIVE_RUN_CLAIM_CHANNEL, request),
  finalizeActiveRunClaim: (request) => ipcRenderer.invoke(ACTIVE_RUN_CLAIM_FINALIZE_CHANNEL, request),
  releaseActiveRunClaim: (request) => ipcRenderer.invoke(ACTIVE_RUN_CLAIM_RELEASE_CHANNEL, request),
  focusWorkspace: (request) => ipcRenderer.invoke(WORKSPACE_FOCUS_CHANNEL, request),
  handoffQueuedMessage: (request) => ipcRenderer.invoke(QUEUED_MESSAGE_HANDOFF_CHANNEL, request),
  onQueuedMessageHandoff: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => {
      Promise.resolve()
        .then(() => callback(payload))
        .then((result) => ipcRenderer.send(QUEUED_MESSAGE_HANDOFF_ACK_CHANNEL, {
          handoffId: payload?.handoffId,
          status: result?.status === 'accepted' || result?.status === 'duplicate' ? 'accepted' : 'rejected',
          messageId: payload?.entry?.messageId,
        }))
        .catch(() => ipcRenderer.send(QUEUED_MESSAGE_HANDOFF_ACK_CHANNEL, {
          handoffId: payload?.handoffId,
          status: 'rejected',
          messageId: payload?.entry?.messageId,
        }))
    }
    ipcRenderer.on(QUEUED_MESSAGE_HANDOFF_EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(QUEUED_MESSAGE_HANDOFF_EVENT_CHANNEL, listener)
  },
  openProjectWorkspace: (request) => ipcRenderer.invoke(WORKSPACE_OPEN_PROJECT_CHANNEL, request),
  openPath: (request) => ipcRenderer.invoke(WORKSPACE_OPEN_PATH_CHANNEL, request),
  onWorkspaceProjectFocus: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, request) => callback(request)
    ipcRenderer.on(WORKSPACE_PROJECT_FOCUS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(WORKSPACE_PROJECT_FOCUS_CHANNEL, listener)
  },
  getWorkspaceRecoveryCandidate: () => ipcRenderer.invoke(WORKSPACE_RECOVERY_CHANNEL),
  getCodexConversationImport: () => ipcRenderer.invoke(CODEX_CONVERSATION_IMPORT_CHANNEL),
  getRecentProjects: () => ipcRenderer.invoke(RECENT_PROJECTS_GET_CHANNEL),
  migrateRecentProjects: (projects) => ipcRenderer.invoke(RECENT_PROJECTS_MIGRATE_CHANNEL, projects),
  rememberRecentProject: (project) => ipcRenderer.invoke(RECENT_PROJECTS_REMEMBER_CHANNEL, project),
  openLocalFile: (path) => ipcRenderer.invoke(LOCAL_FILE_OPEN_CHANNEL, path),
  getDevicePreferences: () => ipcRenderer.invoke(DEVICE_PREFERENCES_GET_CHANNEL),
  setCompletionNotificationPreferences: (settings) => ipcRenderer.invoke(
    COMPLETION_NOTIFICATION_PREFERENCES_SET_CHANNEL,
    settings,
  ),
  setSyncServiceUrl: (url) => ipcRenderer.invoke(SYNC_SERVICE_URL_SET_CHANNEL, url),
  getCloudflareTunnelStatus: () => ipcRenderer.invoke(CLOUDFLARE_TUNNEL_STATUS_CHANNEL),
  setupCloudflareTunnel: (input) => ipcRenderer.invoke(CLOUDFLARE_TUNNEL_SETUP_CHANNEL, input),
  startCloudflareTunnel: () => ipcRenderer.invoke(CLOUDFLARE_TUNNEL_START_CHANNEL),
  stopCloudflareTunnel: () => ipcRenderer.invoke(CLOUDFLARE_TUNNEL_STOP_CHANNEL),
  clearCloudflareTunnel: () => ipcRenderer.invoke(CLOUDFLARE_TUNNEL_CLEAR_CHANNEL),
  startCloudflareQuickTunnel: () => ipcRenderer.invoke(CLOUDFLARE_TUNNEL_QUICK_START_CHANNEL),
  stopCloudflareQuickTunnel: () => ipcRenderer.invoke(CLOUDFLARE_TUNNEL_QUICK_STOP_CHANNEL),
  setTitleBarAppearance: (theme) => ipcRenderer.invoke(TITLEBAR_APPEARANCE_CHANNEL, theme),
  onRecentProjectsChanged: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => callback(state)
    ipcRenderer.on(RECENT_PROJECTS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(RECENT_PROJECTS_CHANGED_CHANNEL, listener)
  },
  chooseProjectFolder: () => ipcRenderer.invoke(PROJECT_FOLDER_PICKER_CHANNEL),
  chooseChatFiles: () => ipcRenderer.invoke(CHAT_FILE_PICKER_CHANNEL),
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  checkForUpdates: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  cancelUpdateDownload: () => ipcRenderer.invoke(UPDATE_CANCEL_CHANNEL),
  applyUpdate: () => ipcRenderer.invoke(UPDATE_APPLY_CHANNEL),
  quitAndInstall: () => ipcRenderer.invoke(UPDATE_QUIT_AND_INSTALL_CHANNEL),
  setUpdateChannel: (channel) => ipcRenderer.invoke(UPDATE_SET_CHANNEL_CHANNEL, channel),
  setUpdateMode: (mode) => ipcRenderer.invoke(UPDATE_SET_MODE_CHANNEL, mode),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => callback(state)
    ipcRenderer.on(UPDATE_STATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, listener)
  },
}))

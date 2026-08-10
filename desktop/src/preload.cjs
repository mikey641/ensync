'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const PROJECT_FOLDER_PICKER_CHANNEL = 'ensync:project-folder:choose'
const CHAT_FILE_PICKER_CHANNEL = 'ensync:chat-files:choose'
const UPDATE_STATE_CHANNEL = 'ensync:updates:state'
const UPDATE_GET_STATE_CHANNEL = 'ensync:updates:get-state'
const UPDATE_CHECK_CHANNEL = 'ensync:updates:check'
const UPDATE_DOWNLOAD_CHANNEL = 'ensync:updates:download'
const UPDATE_CANCEL_CHANNEL = 'ensync:updates:cancel'
const UPDATE_OPEN_INSTALLER_CHANNEL = 'ensync:updates:open-installer'
const UPDATE_SET_CHANNEL_CHANNEL = 'ensync:updates:set-channel'
const WORKSPACE_IDENTITY_CHANNEL = 'ensync:workspace:get-identity'
const WORKSPACE_FOCUS_CHANNEL = 'ensync:workspace:focus'
const WORKSPACE_OPEN_PROJECT_CHANNEL = 'ensync:workspace:open-project'
const WORKSPACE_PROJECT_FOCUS_CHANNEL = 'ensync:workspace:focus-project'
const WORKSPACE_RECOVERY_CHANNEL = 'ensync:workspace:get-recovery-candidate'
const CODEX_CONVERSATION_IMPORT_CHANNEL = 'ensync:workspace:get-codex-conversation-import'
const RECENT_PROJECTS_GET_CHANNEL = 'ensync:recent-projects:get'
const RECENT_PROJECTS_MIGRATE_CHANNEL = 'ensync:recent-projects:migrate'
const RECENT_PROJECTS_REMEMBER_CHANNEL = 'ensync:recent-projects:remember'
const RECENT_PROJECTS_CHANGED_CHANNEL = 'ensync:recent-projects:changed'
const DEVICE_PREFERENCES_GET_CHANNEL = 'ensync:device-preferences:get'
const COMPLETION_NOTIFICATION_PREFERENCES_SET_CHANNEL = 'ensync:device-preferences:set-completion-notifications'

contextBridge.exposeInMainWorld('ensyncDesktop', Object.freeze({
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getWorkspaceIdentity: () => ipcRenderer.invoke(WORKSPACE_IDENTITY_CHANNEL),
  focusWorkspace: (request) => ipcRenderer.invoke(WORKSPACE_FOCUS_CHANNEL, request),
  openProjectWorkspace: (request) => ipcRenderer.invoke(WORKSPACE_OPEN_PROJECT_CHANNEL, request),
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
  getDevicePreferences: () => ipcRenderer.invoke(DEVICE_PREFERENCES_GET_CHANNEL),
  setCompletionNotificationPreferences: (settings) => ipcRenderer.invoke(
    COMPLETION_NOTIFICATION_PREFERENCES_SET_CHANNEL,
    settings,
  ),
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
  openUpdateInstaller: () => ipcRenderer.invoke(UPDATE_OPEN_INSTALLER_CHANNEL),
  setUpdateChannel: (channel) => ipcRenderer.invoke(UPDATE_SET_CHANNEL_CHANNEL, channel),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => callback(state)
    ipcRenderer.on(UPDATE_STATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, listener)
  },
}))

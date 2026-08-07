'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const PROJECT_FOLDER_PICKER_CHANNEL = 'ensync:project-folder:choose'
const UPDATE_STATE_CHANNEL = 'ensync:updates:state'
const UPDATE_GET_STATE_CHANNEL = 'ensync:updates:get-state'
const UPDATE_CHECK_CHANNEL = 'ensync:updates:check'
const UPDATE_DOWNLOAD_CHANNEL = 'ensync:updates:download'
const UPDATE_CANCEL_CHANNEL = 'ensync:updates:cancel'
const UPDATE_OPEN_INSTALLER_CHANNEL = 'ensync:updates:open-installer'
const WORKSPACE_IDENTITY_CHANNEL = 'ensync:workspace:get-identity'
const WORKSPACE_RECOVERY_CHANNEL = 'ensync:workspace:get-recovery-candidate'
const CODEX_CONVERSATION_IMPORT_CHANNEL = 'ensync:workspace:get-codex-conversation-import'
const RECENT_PROJECTS_GET_CHANNEL = 'ensync:recent-projects:get'
const RECENT_PROJECTS_MIGRATE_CHANNEL = 'ensync:recent-projects:migrate'
const RECENT_PROJECTS_REMEMBER_CHANNEL = 'ensync:recent-projects:remember'
const RECENT_PROJECTS_CHANGED_CHANNEL = 'ensync:recent-projects:changed'

contextBridge.exposeInMainWorld('ensyncDesktop', Object.freeze({
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getWorkspaceIdentity: () => ipcRenderer.invoke(WORKSPACE_IDENTITY_CHANNEL),
  getWorkspaceRecoveryCandidate: () => ipcRenderer.invoke(WORKSPACE_RECOVERY_CHANNEL),
  getCodexConversationImport: () => ipcRenderer.invoke(CODEX_CONVERSATION_IMPORT_CHANNEL),
  getRecentProjects: () => ipcRenderer.invoke(RECENT_PROJECTS_GET_CHANNEL),
  migrateRecentProjects: (projects) => ipcRenderer.invoke(RECENT_PROJECTS_MIGRATE_CHANNEL, projects),
  rememberRecentProject: (project) => ipcRenderer.invoke(RECENT_PROJECTS_REMEMBER_CHANNEL, project),
  onRecentProjectsChanged: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => callback(state)
    ipcRenderer.on(RECENT_PROJECTS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(RECENT_PROJECTS_CHANGED_CHANNEL, listener)
  },
  chooseProjectFolder: () => ipcRenderer.invoke(PROJECT_FOLDER_PICKER_CHANNEL),
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  checkForUpdates: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  cancelUpdateDownload: () => ipcRenderer.invoke(UPDATE_CANCEL_CHANNEL),
  openUpdateInstaller: () => ipcRenderer.invoke(UPDATE_OPEN_INSTALLER_CHANNEL),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => callback(state)
    ipcRenderer.on(UPDATE_STATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, listener)
  },
}))

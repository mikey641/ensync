import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import {
  CHAT_FILE_DIALOG_OPTIONS,
  CHAT_FILE_PICKER_CHANNEL,
  CHAT_FILE_PICKER_LIMIT,
  createChatFilePickerHandler,
  createProjectFolderPickerHandler,
  PROJECT_FOLDER_DIALOG_OPTIONS,
  PROJECT_FOLDER_PICKER_CHANNEL,
} from '../src/project-picker.mjs'

test('project folder picker opens one directory-only system dialog for an authorized app window', async () => {
  const event = { sender: { id: 7 } }
  let receivedEvent
  let receivedOptions
  const handler = createProjectFolderPickerHandler({
    isAuthorized: (candidate) => candidate === event,
    openDialog: async (candidate, options) => {
      receivedEvent = candidate
      receivedOptions = options
      return { canceled: false, filePaths: ['/Users/example/project'] }
    },
  })

  assert.deepEqual(await handler(event), {
    status: 'selected',
    path: '/Users/example/project',
  })
  assert.equal(receivedEvent, event)
  assert.deepEqual(receivedOptions, PROJECT_FOLDER_DIALOG_OPTIONS)
  assert.deepEqual(receivedOptions.properties, ['openDirectory'])
})

test('project folder picker accepts a Windows absolute folder path', async () => {
  const handler = createProjectFolderPickerHandler({
    isAuthorized: () => true,
    openDialog: async () => ({ canceled: false, filePaths: ['C:\\Users\\example\\project'] }),
  })

  assert.deepEqual(await handler({}), {
    status: 'selected',
    path: 'C:\\Users\\example\\project',
  })
})

test('project folder picker cancellation is a no-op result', async () => {
  const handler = createProjectFolderPickerHandler({
    isAuthorized: () => true,
    openDialog: async () => ({ canceled: true, filePaths: [] }),
  })

  assert.deepEqual(await handler({}), { status: 'cancelled' })
})

test('project folder picker rejects unauthorized renderers without opening a dialog', async () => {
  let opened = false
  const handler = createProjectFolderPickerHandler({
    isAuthorized: () => false,
    openDialog: async () => {
      opened = true
      return { canceled: false, filePaths: ['/tmp/project'] }
    },
  })

  const result = await handler({})
  assert.equal(result.status, 'error')
  assert.match(result.message, /only to the Ensync app window/)
  assert.equal(opened, false)
})

test('project folder picker reports dialog failures without exposing exception details', async () => {
  const observed = []
  const handler = createProjectFolderPickerHandler({
    isAuthorized: () => true,
    openDialog: async () => { throw new Error('private native detail') },
    onError: (error) => observed.push(error),
  })

  assert.deepEqual(await handler({}), {
    status: 'error',
    message: 'Ensync could not open the system folder chooser.',
  })
  assert.equal(observed.length, 1)
})

test('chat file picker opens a multi-file system dialog and returns deduplicated attachments', async () => {
  const event = { sender: { id: 8 } }
  let receivedEvent
  let receivedOptions
  const handler = createChatFilePickerHandler({
    isAuthorized: (candidate) => candidate === event,
    openDialog: async (candidate, options) => {
      receivedEvent = candidate
      receivedOptions = options
      return {
        canceled: false,
        filePaths: ['/Users/example/screenshot.png', '/Users/example/notes.txt', '/Users/example/screenshot.png'],
      }
    },
  })

  assert.deepEqual(await handler(event), {
    status: 'selected',
    files: [
      { name: 'screenshot.png', path: '/Users/example/screenshot.png' },
      { name: 'notes.txt', path: '/Users/example/notes.txt' },
    ],
  })
  assert.equal(receivedEvent, event)
  assert.deepEqual(receivedOptions, CHAT_FILE_DIALOG_OPTIONS)
  assert.deepEqual(receivedOptions.properties, ['openFile', 'multiSelections'])
})

test('chat file picker derives file names from Windows paths', async () => {
  const handler = createChatFilePickerHandler({
    isAuthorized: () => true,
    openDialog: async () => ({
      canceled: false,
      filePaths: ['C:\\Users\\example\\notes.txt'],
    }),
  })

  assert.deepEqual(await handler({}), {
    status: 'selected',
    files: [{ name: 'notes.txt', path: 'C:\\Users\\example\\notes.txt' }],
  })
})

test('chat file picker cancellation returns no attachment paths', async () => {
  const handler = createChatFilePickerHandler({
    isAuthorized: () => true,
    openDialog: async () => ({ canceled: true, filePaths: [] }),
  })

  assert.deepEqual(await handler({}), { status: 'cancelled' })
})

test('chat file picker rejects unauthorized renderers without opening a dialog', async () => {
  let opened = false
  const handler = createChatFilePickerHandler({
    isAuthorized: () => false,
    openDialog: async () => {
      opened = true
      return { canceled: false, filePaths: ['/tmp/notes.txt'] }
    },
  })

  const result = await handler({})
  assert.equal(result.status, 'error')
  assert.match(result.message, /only to the Ensync app window/)
  assert.equal(opened, false)
})

test('chat file picker enforces the Host attachment limit before returning paths', async () => {
  const handler = createChatFilePickerHandler({
    isAuthorized: () => true,
    openDialog: async () => ({
      canceled: false,
      filePaths: Array.from({ length: CHAT_FILE_PICKER_LIMIT + 1 }, (_, index) => `/tmp/file-${index}.txt`),
    }),
  })

  assert.deepEqual(await handler({}), {
    status: 'error',
    message: `Choose no more than ${CHAT_FILE_PICKER_LIMIT} files at a time.`,
  })
})

test('chat file picker reports malformed dialog paths without exposing exception details', async () => {
  const observed = []
  const handler = createChatFilePickerHandler({
    isAuthorized: () => true,
    openDialog: async () => ({ canceled: false, filePaths: ['relative.txt'] }),
    onError: (error) => observed.push(error),
  })

  assert.deepEqual(await handler({}), {
    status: 'error',
    message: 'Ensync could not open the system file chooser.',
  })
  assert.equal(observed.length, 1)
})

test('sandboxed preload exposes only fixed native bridge invocations', async () => {
  const preloadPath = resolve(import.meta.dirname, '../src/preload.cjs')
  const source = await readFile(preloadPath, 'utf8')
  const exposed = []
  const invocations = []
  const pathLookups = []
  const listeners = new Map()
  const context = vm.createContext({
    Object,
    require: (specifier) => {
      assert.equal(specifier, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld: (name, value) => exposed.push({ name, value }),
        },
        ipcRenderer: {
          invoke: (...args) => {
            invocations.push(args)
            return Promise.resolve({ status: 'cancelled' })
          },
          on: (channel, listener) => listeners.set(channel, listener),
          removeListener: (channel, listener) => {
            if (listeners.get(channel) === listener) listeners.delete(channel)
          },
        },
        webUtils: {
          getPathForFile: (file) => {
            pathLookups.push(file)
            return '/Users/example/dropped.png'
          },
        },
      }
    },
  })

  vm.runInContext(source, context, { filename: preloadPath })
  assert.equal(exposed.length, 1)
  assert.equal(exposed[0].name, 'ensyncDesktop')
  assert.deepEqual(Object.keys(exposed[0].value), [
    'getPathForFile',
    'getWorkspaceIdentity',
    'focusWorkspace',
    'openProjectWorkspace',
    'onWorkspaceProjectFocus',
    'getWorkspaceRecoveryCandidate',
    'getCodexConversationImport',
    'getRecentProjects',
    'migrateRecentProjects',
    'rememberRecentProject',
    'openLocalFile',
    'getDevicePreferences',
    'setCompletionNotificationPreferences',
    'onRecentProjectsChanged',
    'chooseProjectFolder',
    'chooseChatFiles',
    'getUpdateState',
    'checkForUpdates',
    'downloadUpdate',
    'cancelUpdateDownload',
    'openUpdateInstaller',
    'setUpdateChannel',
    'onUpdateState',
  ])
  assert.equal(Object.isFrozen(exposed[0].value), true)
  const droppedFile = { name: 'dropped.png' }
  assert.equal(exposed[0].value.getPathForFile(droppedFile), '/Users/example/dropped.png')
  assert.deepEqual(pathLookups, [droppedFile])
  await exposed[0].value.getWorkspaceIdentity()
  await exposed[0].value.focusWorkspace({
    workspaceId: '11111111-1111-4111-8111-111111111111',
    projectId: 'relay',
    projectPath: '/work/relay',
  })
  await exposed[0].value.openProjectWorkspace({
    projectId: 'nadlan-desk',
    projectPath: '/work/nadlan-desk',
  })
  await exposed[0].value.getWorkspaceRecoveryCandidate()
  await exposed[0].value.getCodexConversationImport()
  await exposed[0].value.getRecentProjects()
  await exposed[0].value.migrateRecentProjects([{ name: 'Relay', path: '/work/relay', host: 'local' }])
  await exposed[0].value.rememberRecentProject({ name: 'Relay', path: '/work/relay', host: 'local' })
  await exposed[0].value.getDevicePreferences()
  await exposed[0].value.setCompletionNotificationPreferences({ mode: 'speech', speechText: 'Done.', voiceId: null })
  await exposed[0].value.chooseProjectFolder()
  await exposed[0].value.chooseChatFiles()
  assert.deepEqual(invocations, [
    ['ensync:workspace:get-identity'],
    ['ensync:workspace:focus', {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      projectId: 'relay',
      projectPath: '/work/relay',
    }],
    ['ensync:workspace:open-project', {
      projectId: 'nadlan-desk',
      projectPath: '/work/nadlan-desk',
    }],
    ['ensync:workspace:get-recovery-candidate'],
    ['ensync:workspace:get-codex-conversation-import'],
    ['ensync:recent-projects:get'],
    ['ensync:recent-projects:migrate', [{ name: 'Relay', path: '/work/relay', host: 'local' }]],
    ['ensync:recent-projects:remember', { name: 'Relay', path: '/work/relay', host: 'local' }],
    ['ensync:device-preferences:get'],
    ['ensync:device-preferences:set-completion-notifications', { mode: 'speech', speechText: 'Done.', voiceId: null }],
    [PROJECT_FOLDER_PICKER_CHANNEL],
    [CHAT_FILE_PICKER_CHANNEL],
  ])
  await exposed[0].value.getUpdateState()
  await exposed[0].value.checkForUpdates()
  await exposed[0].value.downloadUpdate()
  await exposed[0].value.cancelUpdateDownload()
  await exposed[0].value.openUpdateInstaller()
  await exposed[0].value.setUpdateChannel('beta')
  assert.deepEqual(invocations.slice(11), [
    ['ensync:updates:get-state'],
    ['ensync:updates:check'],
    ['ensync:updates:download'],
    ['ensync:updates:cancel'],
    ['ensync:updates:open-installer'],
    ['ensync:updates:set-channel', 'beta'],
  ])
  const states = []
  const unsubscribe = exposed[0].value.onUpdateState((state) => states.push(state))
  listeners.get('ensync:updates:state')({}, { phase: 'available' })
  assert.deepEqual(states, [{ phase: 'available' }])
  unsubscribe()
  assert.equal(listeners.has('ensync:updates:state'), false)
  const recentStates = []
  const unsubscribeRecent = exposed[0].value.onRecentProjectsChanged((state) => recentStates.push(state))
  listeners.get('ensync:recent-projects:changed')({}, { projects: [] })
  assert.deepEqual(recentStates, [{ projects: [] }])
  unsubscribeRecent()
  assert.equal(listeners.has('ensync:recent-projects:changed'), false)
  const focusedProjects = []
  const unsubscribeFocus = exposed[0].value.onWorkspaceProjectFocus((request) => focusedProjects.push(request))
  listeners.get('ensync:workspace:focus-project')({}, { projectId: 'relay', projectPath: '/work/relay' })
  assert.deepEqual(focusedProjects, [{ projectId: 'relay', projectPath: '/work/relay' }])
  unsubscribeFocus()
  assert.equal(listeners.has('ensync:workspace:focus-project'), false)
})

test('desktop package explicitly includes the preload and picker modules', async () => {
  const packagePath = resolve(import.meta.dirname, '../package.json')
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  assert.ok(manifest.build.files.includes('src/preload.cjs'))
  assert.ok(manifest.build.files.includes('src/project-picker.mjs'))
  assert.ok(manifest.build.files.includes('src/recent-projects.mjs'))
  assert.ok(manifest.build.files.includes('src/device-preferences.mjs'))
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

test('workspace identity IPC is installed before updater waits or BrowserWindow construction', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../src/main.mjs'), 'utf8')
  const readyBlock = source.slice(source.indexOf('void app.whenReady()'))
  assert.ok(readyBlock.indexOf('registerNativeBridge()') >= 0)
  assert.ok(readyBlock.indexOf('registerNativeBridge()') < readyBlock.indexOf('return updateManager.initialize()'))

  const createWindowBlock = source.slice(
    source.indexOf('async function createWindow('),
    source.indexOf("if (!singleInstance)"),
  )
  assert.ok(createWindowBlock.indexOf('workspaceIdentityIpc.register()') >= 0)
  assert.ok(createWindowBlock.indexOf('workspaceIdentityIpc.register()') < createWindowBlock.indexOf('new BrowserWindow('))
  assert.ok(createWindowBlock.indexOf('nativeWindows.add(window, workspaceIdentity)') < createWindowBlock.indexOf('window.loadURL('))
})

test('renderer verifies native workspace identity before dynamically importing App', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../../src/main.tsx'), 'utf8')
  assert.ok(source.indexOf('await initializeNativeWorkspaceIdentity(globalThis)') >= 0)
  assert.ok(source.indexOf('await initializeNativeWorkspaceIdentity(globalThis)') < source.indexOf("await import('./App')"))
  assert.ok(source.indexOf('await initializeNativeWorkspaceRecovery(globalThis)') > source.indexOf('await initializeNativeWorkspaceIdentity(globalThis)'))
  assert.ok(source.indexOf('await initializeNativeWorkspaceRecovery(globalThis)') < source.indexOf("await import('./App')"))
})

test('native windows leave standard renderer reload shortcuts unblocked', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../src/main.mjs'), 'utf8')
  const createWindowBlock = source.slice(
    source.indexOf('async function createWindow('),
    source.indexOf("if (!singleInstance)"),
  )

  assert.equal(createWindowBlock.includes('shouldBlockNativeReloadShortcut'), false)
})

test('native bridge registers authenticated active-run publication and target-first handoff before windows load', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../src/main.mjs'), 'utf8')
  const bridgeBlock = source.slice(
    source.indexOf('function registerNativeBridge()'),
    source.indexOf('function unregisterNativeBridge()'),
  )
  const createWindowBlock = source.slice(
    source.indexOf('async function createWindow('),
    source.indexOf("if (!singleInstance)"),
  )

  assert.ok(source.includes('createActiveRunRoster'))
  assert.ok(source.includes('createQueuedMessageHandoffHandlers'))
  assert.ok(bridgeBlock.includes('ACTIVE_RUNS_PUBLISH_CHANNEL'))
  assert.ok(bridgeBlock.includes('QUEUED_MESSAGE_HANDOFF_CHANNEL'))
  assert.ok(bridgeBlock.includes('QUEUED_MESSAGE_HANDOFF_ACK_CHANNEL'))
  assert.ok(bridgeBlock.includes('activeRuns: activeRunRoster'))
  assert.ok(createWindowBlock.includes('queuedMessageHandoffs.removeWorkspace(workspaceIdentity.id)'))
  assert.ok(bridgeBlock.indexOf('ACTIVE_RUNS_PUBLISH_CHANNEL') < bridgeBlock.indexOf('window.loadURL(') || !bridgeBlock.includes('window.loadURL('))
})

test('preload exposes only fixed active-run and queued-message handoff bridge methods', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../src/preload.cjs'), 'utf8')
  assert.ok(source.includes("const ACTIVE_RUNS_PUBLISH_CHANNEL = 'ensync:workspace:publish-active-runs'"))
  assert.ok(source.includes("const QUEUED_MESSAGE_HANDOFF_CHANNEL = 'ensync:workspace:handoff-queued-message'"))
  assert.ok(source.includes("const QUEUED_MESSAGE_HANDOFF_ACK_CHANNEL = 'ensync:workspace:queued-message-handoff-ack'"))
  assert.ok(source.includes("const QUEUED_MESSAGE_HANDOFF_EVENT_CHANNEL = 'ensync:workspace:queued-message-handoff'"))
  assert.ok(source.includes('publishActiveRuns: (entries) => ipcRenderer.invoke(ACTIVE_RUNS_PUBLISH_CHANNEL, entries)'))
  assert.ok(source.includes('handoffQueuedMessage: (request) => ipcRenderer.invoke(QUEUED_MESSAGE_HANDOFF_CHANNEL, request)'))
  assert.ok(source.includes('onQueuedMessageHandoff: (callback) =>'))
  assert.equal(source.includes('ipcRenderer: ipcRenderer'), false)
  assert.equal(source.includes('send: (...args) => ipcRenderer.send(...args)'), false)
})

test('renderer bridge types distinguish legacy project focus from exact active-run focus', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../../src/vite-env.d.ts'), 'utf8')
  assert.ok(source.includes('type NativeExactRunTarget = {'))
  assert.ok(source.includes('type NativeWorkspaceFocusRequest = NativeLegacyWorkspaceFocusTarget | NativeExactRunTarget'))
  assert.ok(source.includes('type NativeWorkspaceProjectFocusRequest = NativeLegacyProjectFocusRequest | NativeExactRunTarget'))
  assert.ok(source.includes('chatId?: never'))
  assert.ok(source.includes('jobId?: never'))
  assert.ok(source.includes('focusWorkspace?: (request: NativeWorkspaceFocusRequest) => Promise<boolean>'))
  assert.ok(source.includes('onWorkspaceProjectFocus?: (callback: (request: NativeWorkspaceProjectFocusRequest) => void) => () => void'))
})

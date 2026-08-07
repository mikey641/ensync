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

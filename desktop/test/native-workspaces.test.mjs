import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createNativeWorkspaceIdentity,
  createNativeWorkspaceStore,
  createWorkspaceFocusHandler,
  createWorkspaceIdentityHandler,
  createWorkspaceIdentityIpcManager,
  createWorkspaceOpenProjectHandler,
  isNativeWorkspaceIdentity,
  nativeWorkspaceRestorationOrder,
  shouldRetainNativeWorkspaceOnClose,
} from '../src/native-workspaces.mjs'

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
]

test('native workspace identities are generated opaque UUIDs and validated', () => {
  const identity = createNativeWorkspaceIdentity('isolated', () => IDS[0])
  assert.deepEqual(identity, { id: IDS[0], kind: 'isolated' })
  assert.equal(isNativeWorkspaceIdentity(identity), true)
  assert.equal(isNativeWorkspaceIdentity({ id: 'user-key', kind: 'isolated' }), false)
  assert.throws(() => createNativeWorkspaceIdentity('isolated', () => 'user-key'))
})

test('native workspace store restores canonical and isolated windows independently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-native-workspaces-'))
  const filePath = join(directory, 'native-workspaces-v1.json')
  let index = 0
  const store = createNativeWorkspaceStore({ filePath, createId: () => IDS[index++] })
  const canonical = store.ensureCanonical()
  const isolated = store.createIsolated()
  assert.deepEqual(store.list(), [canonical, isolated])

  const restored = createNativeWorkspaceStore({ filePath, createId: () => IDS[index++] })
  assert.deepEqual(restored.list(), [canonical, isolated])
  assert.equal(restored.touch(canonical.id), true)
  assert.deepEqual(restored.list().map((item) => item.id), [isolated.id, canonical.id])
  assert.equal(restored.remove(isolated.id), true)
  assert.deepEqual(restored.list(), [canonical])
})

test('relaunch always opens the canonical unsuffixed workspace before focused isolated windows', () => {
  const isolated = { id: IDS[0], kind: 'isolated' }
  const canonical = { id: IDS[1], kind: 'canonical' }
  const anotherIsolated = { id: IDS[2], kind: 'isolated' }
  assert.deepEqual(nativeWorkspaceRestorationOrder([isolated, canonical, anotherIsolated]), [
    canonical,
    isolated,
    anotherIsolated,
  ])
  assert.throws(() => nativeWorkspaceRestorationOrder([{ id: 'invalid', kind: 'canonical' }]))
})

test('closing canonical beside an isolated window cannot orphan the canonical relaunch workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-native-workspaces-'))
  const filePath = join(directory, 'native-workspaces-v1.json')
  let index = 0
  const store = createNativeWorkspaceStore({ filePath, createId: () => IDS[index++] })
  const canonical = store.ensureCanonical()
  const isolated = store.createIsolated()
  assert.equal(shouldRetainNativeWorkspaceOnClose({
    identity: canonical, quitting: false, platform: 'darwin', openWindowCount: 2,
  }), true)

  const relaunched = createNativeWorkspaceStore({ filePath, createId: () => IDS[index++] })
  relaunched.ensureCanonical()
  assert.deepEqual(relaunched.list(), [canonical, isolated])
})

test('manual isolated close is discarded while app quit retains open workspaces', () => {
  const canonical = { id: IDS[0], kind: 'canonical' }
  const isolated = { id: IDS[1], kind: 'isolated' }
  assert.equal(shouldRetainNativeWorkspaceOnClose({
    identity: isolated, quitting: false, platform: 'darwin', openWindowCount: 2,
  }), false)
  assert.equal(shouldRetainNativeWorkspaceOnClose({
    identity: isolated, quitting: true, platform: 'darwin', openWindowCount: 2,
  }), true)
  assert.equal(shouldRetainNativeWorkspaceOnClose({
    identity: isolated, quitting: false, platform: 'win32', openWindowCount: 1,
  }), true)
  assert.equal(shouldRetainNativeWorkspaceOnClose({
    identity: canonical, quitting: false, platform: 'win32', openWindowCount: 2,
  }), true)
})

test('native workspace store recovers a complete staging record after primary corruption', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-native-workspaces-'))
  const filePath = join(directory, 'native-workspaces-v1.json')
  const store = createNativeWorkspaceStore({ filePath, createId: () => IDS[0] })
  const canonical = store.ensureCanonical()
  writeFileSync(`${filePath}.staging`, readFileSync(filePath))
  writeFileSync(filePath, '{corrupt')

  const restored = createNativeWorkspaceStore({ filePath, createId: () => IDS[1] })
  assert.deepEqual(restored.list(), [canonical])
})

test('workspace identity IPC returns only an authorized registered identity', async () => {
  const identity = { id: IDS[0], kind: 'canonical' }
  const sender = {}
  const handler = createWorkspaceIdentityHandler({
    isAuthorized: (event) => event.sender === sender,
    identityForWebContents: (webContents) => webContents === sender ? identity : null,
    retainedIdentities: () => [identity],
  })
  assert.deepEqual(await handler({ sender }), {
    ...identity,
    retainedWorkspaceIds: [identity.id],
    retainedWorkspaces: [identity],
  })
  assert.equal(await handler({ sender: {} }), null)
})

test('workspace identity IPC carries only a shell-issued project-window launch', async () => {
  const source = { id: IDS[0], kind: 'canonical' }
  const target = { id: IDS[1], kind: 'isolated' }
  const sender = {}
  const projectLaunch = {
    projectId: 'project-nadlan',
    projectPath: '/Users/example/nadlan-desk',
    sourceWorkspace: source,
  }
  const handler = createWorkspaceIdentityHandler({
    isAuthorized: (event) => event.sender === sender,
    identityForWebContents: () => target,
    retainedIdentities: () => [source, target],
    projectLaunchForIdentity: (identity) => identity.id === target.id ? projectLaunch : null,
  })
  assert.deepEqual(await handler({ sender }), {
    ...target,
    retainedWorkspaceIds: [source.id, target.id],
    retainedWorkspaces: [source, target],
    projectLaunch,
  })

  const invalid = createWorkspaceIdentityHandler({
    isAuthorized: () => true,
    identityForWebContents: () => target,
    retainedIdentities: () => [target],
    projectLaunchForIdentity: () => ({ ...projectLaunch, sourceWorkspace: target }),
  })
  assert.equal('projectLaunch' in await invalid({ sender }), false)
})

test('workspace identity IPC manager registers once and remains installed while windows exist', async () => {
  const identity = { id: IDS[0], kind: 'canonical' }
  const ownedSender = { id: 7 }
  const handlers = new Map()
  let handleCalls = 0
  let removeCalls = 0
  let registeredWindows = 0
  const manager = createWorkspaceIdentityIpcManager({
    ipcMain: {
      handle(channel, handler) {
        handleCalls += 1
        assert.equal(handlers.has(channel), false)
        handlers.set(channel, handler)
      },
      removeHandler(channel) {
        removeCalls += 1
        handlers.delete(channel)
      },
    },
    isAuthorized: (event) => event.sender === ownedSender,
    identityForWebContents: (sender) => sender === ownedSender ? identity : null,
    retainedIdentities: () => [identity],
    hasRegisteredWindows: () => registeredWindows > 0,
  })

  assert.equal(manager.register(), true)
  assert.equal(manager.register(), false)
  assert.equal(handleCalls, 1)
  assert.equal(manager.registered, true)
  const handler = handlers.get('ensync:workspace:get-identity')
  assert.deepEqual(await handler({ sender: ownedSender }), {
    ...identity,
    retainedWorkspaceIds: [identity.id],
    retainedWorkspaces: [identity],
  })
  assert.equal(await handler({ sender: {} }), null)

  registeredWindows = 2
  assert.equal(manager.dispose(), false)
  assert.equal(removeCalls, 0)
  assert.equal(manager.registered, true)
  assert.strictEqual(handlers.get('ensync:workspace:get-identity'), handler)

  registeredWindows = 0
  assert.equal(manager.dispose(), true)
  assert.equal(removeCalls, 1)
  assert.equal(manager.registered, false)
  assert.equal(manager.dispose(), false)
})

test('workspace focus routes only authorized project requests to a different retained window', async () => {
  const source = { id: IDS[0], kind: 'isolated' }
  const target = { id: IDS[1], kind: 'canonical' }
  const sender = {}
  const targetWindow = {}
  const actions = []
  const handler = createWorkspaceFocusHandler({
    isAuthorized: (event) => event.sender === sender,
    identityForWebContents: (webContents) => webContents === sender ? source : null,
    retainedIdentities: () => [source, target],
    windowForWorkspace: (id) => id === target.id ? targetWindow : null,
    focusWindow: (window) => { actions.push(['focus', window]); return true },
    notifyProjectFocus: (window, project) => { actions.push(['notify', window, project]) },
  })
  const request = {
    workspaceId: target.id,
    projectId: 'project-relay',
    projectPath: '/Users/example/relay',
  }
  assert.equal(await handler({ sender }, request), true)
  assert.deepEqual(actions, [
    ['focus', targetWindow],
    ['notify', targetWindow, { projectId: 'project-relay', projectPath: '/Users/example/relay' }],
  ])
  assert.equal(await handler({ sender: {} }, request), false)
  assert.equal(await handler({ sender }, { ...request, workspaceId: source.id }), false)
  assert.equal(await handler({ sender }, { ...request, projectPath: 'relative/path' }), false)
})

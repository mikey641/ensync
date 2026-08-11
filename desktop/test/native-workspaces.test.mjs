import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as nativeWorkspaces from '../src/native-workspaces.mjs'

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

test('manually closing canonical beside another window retires its relaunch identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-native-workspaces-'))
  const filePath = join(directory, 'native-workspaces-v1.json')
  let index = 0
  const store = createNativeWorkspaceStore({ filePath, createId: () => IDS[index++] })
  const canonical = store.ensureCanonical()
  const relay = store.createIsolated()
  const nadlan = store.createIsolated()
  assert.equal(shouldRetainNativeWorkspaceOnClose({
    identity: canonical, quitting: false, platform: 'darwin', openWindowCount: 3,
  }), false)
  store.remove(canonical.id)

  const relaunched = createNativeWorkspaceStore({ filePath, createId: () => IDS[index++] })
  assert.deepEqual(relaunched.list(), [relay, nadlan])
  assert.deepEqual(relaunched.ensureRestorable(), nadlan)
  assert.deepEqual(relaunched.list(), [relay, nadlan])
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
  }), false)
  assert.equal(shouldRetainNativeWorkspaceOnClose({
    identity: canonical, quitting: false, platform: 'darwin', openWindowCount: 1,
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

test('active run roster authenticates publication, replaces workspace jobs atomically, and bounds entries', () => {
  const source = { id: IDS[0], kind: 'isolated' }
  const target = { id: IDS[1], kind: 'canonical' }
  const sourceSender = { id: 7 }
  const targetSender = { id: 8 }
  const roster = nativeWorkspaces.createActiveRunRoster({
    isAuthorized: (event) => event.sender === sourceSender || event.sender === targetSender,
    identityForWebContents: (sender) => sender === sourceSender ? source : sender === targetSender ? target : null,
  })
  const entry = (jobId, projectPath = '/Users/example/relay') => ({
    workspaceId: source.id,
    projectId: 'project-relay',
    projectPath,
    chatId: 'chat-relay',
    jobId,
  })

  assert.equal(roster.publish({ sender: {} }, [entry('job-old')]), false)
  assert.equal(roster.publish({ sender: sourceSender }, [{ ...entry('job-old'), workspaceId: target.id }]), false)
  assert.deepEqual(roster.listForWorkspace(source.id), [])

  assert.equal(roster.publish({ sender: sourceSender }, [entry('job-old')]), true)
  assert.equal(roster.matches(entry('job-old')), true)
  assert.equal(roster.publish({ sender: sourceSender }, [entry('job-new', 'C:\\Users\\example\\relay')]), true)
  assert.equal(roster.matches(entry('job-old')), false)
  assert.equal(roster.matches(entry('job-new', 'C:\\Users\\example\\relay')), true)
  assert.equal(roster.matches({ ...entry('job-new', 'C:\\Users\\example\\relay'), chatId: 'other-chat' }), false)
  assert.equal(roster.matches({ ...entry('job-new', 'C:\\Users\\example\\relay'), projectPath: '\\\\server\\share\\relay' }), false)

  const bounded = Array.from({ length: 32 }, (_, index) => entry(`job-${index}`))
  assert.equal(roster.publish({ sender: sourceSender }, bounded), true)
  assert.equal(roster.listForWorkspace(source.id).length, 32)
  assert.equal(roster.publish({ sender: sourceSender }, [...bounded, entry('job-overflow')]), false)
  assert.deepEqual(roster.listForWorkspace(source.id), bounded)
  assert.equal(roster.removeWorkspace(source.id), true)
  assert.equal(roster.matches(entry('job-0')), false)
})

test('active run match queries require an authorized exact live roster binding', () => {
  const sourceSender = { id: 7 }
  const targetSender = { id: 8 }
  const target = { id: IDS[1], kind: 'canonical' }
  const roster = nativeWorkspaces.createActiveRunRoster({
    isAuthorized: (event) => event.sender === sourceSender || event.sender === targetSender,
    identityForWebContents: (sender) => sender === targetSender ? target : { id: IDS[0], kind: 'isolated' },
  })
  const binding = {
    workspaceId: target.id,
    projectId: 'project-relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-relay',
    jobId: 'job-relay',
  }
  assert.equal(roster.publish({ sender: targetSender }, [binding]), true)
  const match = nativeWorkspaces.createActiveRunMatchHandler({
    isAuthorized: (event) => event.sender === sourceSender,
    activeRuns: roster,
  })
  assert.equal(match({ sender: sourceSender }, binding), true)
  assert.equal(match({ sender: sourceSender }, { ...binding, jobId: 'job-stale' }), false)
  assert.equal(match({ sender: {} }, binding), false)
})

test('exact active run focus requires the authenticated workspace, project, path, chat, and job binding', async () => {
  const source = { id: IDS[0], kind: 'isolated' }
  const target = { id: IDS[1], kind: 'canonical' }
  const sourceSender = { id: 7 }
  const targetSender = { id: 8 }
  const targetWindow = {}
  const activeRuns = nativeWorkspaces.createActiveRunRoster({
    isAuthorized: (event) => event.sender === sourceSender || event.sender === targetSender,
    identityForWebContents: (sender) => sender === sourceSender ? source : sender === targetSender ? target : null,
  })
  const exact = {
    workspaceId: target.id,
    projectId: 'project-relay',
    projectPath: '\\\\server\\share\\relay',
    chatId: 'chat-relay',
    jobId: 'job-relay',
  }
  assert.equal(activeRuns.publish({ sender: targetSender }, [exact]), true)
  const actions = []
  const handler = createWorkspaceFocusHandler({
    isAuthorized: (event) => event.sender === sourceSender,
    identityForWebContents: (sender) => sender === sourceSender ? source : null,
    retainedIdentities: () => [source, target],
    windowForWorkspace: (id) => id === target.id ? targetWindow : null,
    focusWindow: (window) => { actions.push(['focus', window]); return true },
    notifyProjectFocus: (window, request) => { actions.push(['notify', window, request]) },
    activeRuns,
  })

  assert.equal(await handler({ sender: sourceSender }, exact), true)
  assert.deepEqual(actions, [
    ['focus', targetWindow],
    ['notify', targetWindow, exact],
  ])
  assert.equal(await handler({ sender: sourceSender }, { ...exact, jobId: 'job-other' }), false)
  assert.equal(await handler({ sender: sourceSender }, { ...exact, chatId: 'chat-other' }), false)
  assert.equal(await handler({ sender: sourceSender }, { ...exact, projectPath: '/Users/example/relay' }), false)
  assert.equal(await handler({ sender: sourceSender }, {
    workspaceId: target.id,
    projectId: exact.projectId,
    projectPath: exact.projectPath,
    chatId: exact.chatId,
  }), false)
  activeRuns.removeWorkspace(target.id)
  assert.equal(await handler({ sender: sourceSender }, exact), false)
})

test('queued message handoff waits for the target ACK, is idempotent, and becomes unavailable after workspace cleanup', async () => {
  const source = { id: IDS[0], kind: 'isolated' }
  const target = { id: IDS[1], kind: 'canonical' }
  const otherSource = { id: IDS[2], kind: 'isolated' }
  const sourceSender = { id: 7 }
  const targetSender = { id: 8 }
  const otherSourceSender = { id: 9 }
  const targetWindow = { webContents: targetSender }
  const activeRuns = nativeWorkspaces.createActiveRunRoster({
    isAuthorized: (event) => event.sender === sourceSender
      || event.sender === targetSender
      || event.sender === otherSourceSender,
    identityForWebContents: (sender) => sender === sourceSender
      ? source
      : sender === targetSender ? target : sender === otherSourceSender ? otherSource : null,
  })
  const targetBinding = {
    workspaceId: target.id,
    projectId: 'project-relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-relay',
    jobId: 'job-relay',
  }
  assert.equal(activeRuns.publish({ sender: targetSender }, [targetBinding]), true)
  const sent = []
  const handoffs = nativeWorkspaces.createQueuedMessageHandoffHandlers({
    isAuthorized: (event) => event.sender === sourceSender
      || event.sender === targetSender
      || event.sender === otherSourceSender,
    identityForWebContents: (sender) => sender === sourceSender
      ? source
      : sender === targetSender ? target : sender === otherSourceSender ? otherSource : null,
    activeRuns,
    windowForWorkspace: (id) => id === target.id ? targetWindow : null,
    sendToWebContents: (webContents, channel, payload) => sent.push([webContents, channel, payload]),
    timeoutMs: 100,
  })
  const request = {
    handoffId: 'handoff-relay',
    target: targetBinding,
    entry: {
      id: 'queued-relay',
      turnId: 'turn-queued',
      messageId: 'message-queued',
      prompt: 'Continue the active task.',
      attachments: [{ name: 'notes.txt', path: '/Users/example/notes.txt' }],
      enqueuedAt: '2026-08-11T10:00:00.000Z',
      predecessorTurnId: 'turn-active',
      resumeApprovedAt: null,
      preferences: {
        providerMode: 'fixed',
        provider: 'codex',
        sizeTier: null,
        automaticFallback: false,
        autoContextSkill: true,
        fallbackProviderOrder: ['codex'],
        executionTargetKey: 'local',
        projectId: targetBinding.projectId,
        projectPath: targetBinding.projectPath,
      },
      ignored: 'must not cross IPC',
    },
  }

  const pending = handoffs.handoff({ sender: sourceSender }, request)
  await Promise.resolve()
  assert.equal(sent.length, 1)
  assert.equal(sent[0][2].entry.ignored, undefined)
  assert.equal(handoffs.ack({ sender: targetSender }, {
    handoffId: request.handoffId,
    status: 'accepted',
    messageId: request.entry.messageId,
  }), true)
  assert.deepEqual(await pending, {
    status: 'accepted', handoffId: request.handoffId, messageId: request.entry.messageId,
  })
  assert.deepEqual(await handoffs.handoff({ sender: sourceSender }, request), {
    status: 'accepted', handoffId: request.handoffId, messageId: request.entry.messageId,
  })
  assert.equal(activeRuns.publish({ sender: targetSender }, []), true)
  assert.deepEqual(await handoffs.handoff({ sender: sourceSender }, request), {
    status: 'accepted', handoffId: request.handoffId, messageId: request.entry.messageId,
  })
  assert.equal(sent.length, 1)
  assert.deepEqual(await handoffs.handoff({ sender: sourceSender }, {
    ...request,
    entry: { ...request.entry, prompt: 'Conflicting prompt.' },
  }), {
    status: 'rejected', handoffId: request.handoffId, messageId: request.entry.messageId,
  })
  assert.equal(activeRuns.publish({ sender: targetSender }, [targetBinding]), true)

  const sourceBoundRequest = { ...request, handoffId: 'handoff-source-bound' }
  const sourceBoundPending = handoffs.handoff({ sender: sourceSender }, sourceBoundRequest)
  const otherSourcePending = handoffs.handoff({ sender: otherSourceSender }, sourceBoundRequest)
  const sharedPendingPromise = sourceBoundPending === otherSourcePending
  assert.equal(handoffs.ack({ sender: targetSender }, {
    handoffId: sourceBoundRequest.handoffId,
    status: 'accepted',
    messageId: request.entry.messageId,
  }), true)
  assert.equal((await sourceBoundPending).status, 'accepted')
  assert.equal(sharedPendingPromise, false)
  assert.equal((await otherSourcePending).status, 'rejected')
  assert.equal((await handoffs.handoff({ sender: otherSourceSender }, sourceBoundRequest)).status, 'rejected')

  const maximumPromptRequest = {
    ...request,
    handoffId: 'handoff-maximum-prompt',
    entry: { ...request.entry, prompt: 'x'.repeat(100_000) },
  }
  const maximumPromptPending = handoffs.handoff({ sender: sourceSender }, maximumPromptRequest)
  assert.equal(sent.length, 3)
  assert.equal(handoffs.ack({ sender: targetSender }, {
    handoffId: maximumPromptRequest.handoffId,
    status: 'accepted',
    messageId: request.entry.messageId,
  }), true)
  assert.equal((await maximumPromptPending).status, 'accepted')
  assert.equal((await handoffs.handoff({ sender: sourceSender }, {
    ...maximumPromptRequest,
    handoffId: 'handoff-over-maximum-prompt',
    entry: { ...maximumPromptRequest.entry, prompt: 'x'.repeat(100_001) },
  })).status, 'rejected')
  assert.equal(sent.length, 3)

  const maximumAttachments = Array.from({ length: 64 }, (_, index) => ({
    name: `attachment-${index}.txt`,
    path: `/Users/example/attachment-${index}.txt`,
  }))
  const maximumAttachmentsRequest = {
    ...request,
    handoffId: 'handoff-maximum-attachments',
    entry: { ...request.entry, attachments: maximumAttachments },
  }
  const maximumAttachmentsPending = handoffs.handoff({ sender: sourceSender }, maximumAttachmentsRequest)
  assert.equal(sent.length, 4)
  assert.equal(handoffs.ack({ sender: targetSender }, {
    handoffId: maximumAttachmentsRequest.handoffId,
    status: 'accepted',
    messageId: request.entry.messageId,
  }), true)
  assert.equal((await maximumAttachmentsPending).status, 'accepted')
  assert.equal((await handoffs.handoff({ sender: sourceSender }, {
    ...maximumAttachmentsRequest,
    handoffId: 'handoff-over-maximum-attachments',
    entry: {
      ...maximumAttachmentsRequest.entry,
      attachments: [...maximumAttachments, { name: 'overflow.txt', path: '/Users/example/overflow.txt' }],
    },
  })).status, 'rejected')
  assert.equal(sent.length, 4)

  const withoutAttachments = {
    ...request,
    handoffId: 'handoff-no-attachments',
    entry: { ...request.entry },
  }
  delete withoutAttachments.entry.attachments
  const pendingWithoutAttachments = handoffs.handoff({ sender: sourceSender }, withoutAttachments)
  await Promise.resolve()
  assert.equal(sent.length, 5)
  assert.deepEqual(sent.at(-1)[2].entry.attachments, [])
  assert.equal(handoffs.ack({ sender: targetSender }, {
    handoffId: withoutAttachments.handoffId,
    status: 'accepted',
    messageId: request.entry.messageId,
  }), true)
  assert.equal((await pendingWithoutAttachments).status, 'accepted')

  const retainedRecordLimit = 128
  let lastBulkRequest = null
  for (let index = 0; index < retainedRecordLimit + 16; index += 1) {
    lastBulkRequest = { ...request, handoffId: `handoff-bulk-${index}` }
    const bulkPending = handoffs.handoff({ sender: sourceSender }, lastBulkRequest)
    assert.equal(handoffs.ack({ sender: targetSender }, {
      handoffId: lastBulkRequest.handoffId,
      status: 'accepted',
      messageId: request.entry.messageId,
    }), true)
    assert.equal((await bulkPending).status, 'accepted')
  }
  assert.equal(handoffs.retainedRecordCount, retainedRecordLimit)
  const deliveriesAfterBulk = sent.length
  assert.equal(activeRuns.publish({ sender: targetSender }, []), true)
  assert.equal((await handoffs.handoff({ sender: sourceSender }, lastBulkRequest)).status, 'accepted')
  assert.equal(sent.length, deliveriesAfterBulk)
  assert.equal(activeRuns.publish({ sender: targetSender }, [targetBinding]), true)

  const sourceUnavailable = handoffs.handoff({ sender: sourceSender }, { ...request, handoffId: 'handoff-source-closed' })
  await Promise.resolve()
  handoffs.removeWorkspace(source.id)
  assert.equal(handoffs.retainedRecordCount, 0)
  assert.deepEqual(await sourceUnavailable, {
    status: 'unavailable', handoffId: 'handoff-source-closed', messageId: request.entry.messageId,
  })

  const unavailable = handoffs.handoff({ sender: sourceSender }, { ...request, handoffId: 'handoff-closed' })
  await Promise.resolve()
  assert.equal(handoffs.removeWorkspace(target.id), true)
  assert.deepEqual(await unavailable, {
    status: 'unavailable', handoffId: 'handoff-closed', messageId: request.entry.messageId,
  })
})

test('a timed-out exact handoff redelivers for tombstone reconciliation without changing Stop approval', async () => {
  const source = { id: IDS[0], kind: 'isolated' }
  const target = { id: IDS[1], kind: 'canonical' }
  const sourceSender = { id: 7 }
  const targetSender = { id: 8 }
  const targetWindow = { webContents: targetSender }
  const activeRuns = nativeWorkspaces.createActiveRunRoster({
    isAuthorized: (event) => event.sender === sourceSender || event.sender === targetSender,
    identityForWebContents: (sender) => sender === sourceSender ? source : sender === targetSender ? target : null,
  })
  const targetBinding = {
    workspaceId: target.id,
    projectId: 'project-relay',
    projectPath: '/Users/example/relay',
    chatId: 'chat-relay',
    jobId: 'job-relay',
  }
  assert.equal(activeRuns.publish({ sender: targetSender }, [targetBinding]), true)
  const sent = []
  const handoffs = nativeWorkspaces.createQueuedMessageHandoffHandlers({
    isAuthorized: (event) => event.sender === sourceSender || event.sender === targetSender,
    identityForWebContents: (sender) => sender === sourceSender ? source : sender === targetSender ? target : null,
    activeRuns,
    windowForWorkspace: (id) => id === target.id ? targetWindow : null,
    sendToWebContents: (_webContents, _channel, payload) => sent.push(payload),
    timeoutMs: 5,
  })
  const request = {
    handoffId: 'handoff-timeout-reconcile',
    target: targetBinding,
    entry: {
      id: 'queued-timeout-reconcile',
      turnId: 'turn-queued',
      messageId: 'message-queued',
      prompt: 'Continue the active task.',
      attachments: [],
      enqueuedAt: '2026-08-11T10:00:00.000Z',
      predecessorTurnId: 'turn-active',
      resumeApprovedAt: '2026-08-11T10:00:01.000Z',
      preferences: {
        providerMode: 'fixed',
        provider: 'claude',
        sizeTier: null,
        automaticFallback: false,
        autoContextSkill: true,
        fallbackProviderOrder: ['claude'],
        executionTargetKey: 'local',
        projectId: targetBinding.projectId,
        projectPath: targetBinding.projectPath,
      },
    },
  }

  assert.equal((await handoffs.handoff({ sender: sourceSender }, request)).status, 'unavailable')
  assert.equal(sent.length, 1)
  assert.equal(activeRuns.publish({ sender: targetSender }, []), true)
  const retried = handoffs.handoff({ sender: sourceSender }, {
    ...request,
    entry: { ...request.entry, resumeApprovedAt: '2026-08-11T10:00:09.000Z' },
  })
  await Promise.resolve()
  assert.equal(sent.length, 2)
  assert.equal(sent[1].entry.resumeApprovedAt, request.entry.resumeApprovedAt)
  assert.equal(handoffs.ack({ sender: targetSender }, {
    handoffId: request.handoffId,
    status: 'accepted',
    messageId: request.entry.messageId,
  }), true)
  assert.equal((await retried).status, 'accepted')
  assert.equal((await handoffs.handoff({ sender: sourceSender }, {
    ...request,
    entry: { ...request.entry, resumeApprovedAt: null },
  })).status, 'rejected')
  assert.equal((await handoffs.handoff({ sender: sourceSender }, {
    ...request,
    entry: { ...request.entry, prompt: 'Changed content.' },
  })).status, 'rejected')
})

test('opening a project workspace is authorized and keeps the source identity', async () => {
  const source = { id: IDS[0], kind: 'canonical' }
  const sender = {}
  const calls = []
  const handler = createWorkspaceOpenProjectHandler({
    isAuthorized: (event) => event.sender === sender,
    identityForWebContents: (webContents) => webContents === sender ? source : null,
    openProjectWindow: (project, sourceWorkspace) => {
      calls.push({ project, sourceWorkspace })
      return true
    },
  })
  const project = { projectId: 'project-nadlan', projectPath: '/Users/example/nadlan-desk' }
  assert.equal(await handler({ sender }, project), true)
  assert.deepEqual(calls, [{ project, sourceWorkspace: source }])
  assert.equal(await handler({ sender: {} }, project), false)
  assert.equal(await handler({ sender }, { ...project, projectPath: 'relative/path' }), false)
  assert.equal(calls.length, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getRetainedNativeWorkspaceIds,
  initializeNativeWorkspaceIdentity,
  isCanonicalWorkspace,
  isMissingWorkspaceIdentityHandlerError,
  removeAbandonedNativeWorkspaceStorage,
  workspaceStorageKey,
} from '../src/lib/nativeWorkspaceIdentity.mjs'

function storageFrom(entries) {
  const values = new Map(entries)
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    removeItem(key) { values.delete(key) },
    values,
  }
}

test('renderer accepts only a verified shell-issued workspace identity', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const storage = storageFrom([])
  const identity = await initializeNativeWorkspaceIdentity({
    localStorage: storage,
    ensyncDesktop: { getWorkspaceIdentity: async () => ({ id, kind: 'isolated', retainedWorkspaceIds: [id] }) },
  })
  assert.deepEqual(identity, { id, kind: 'isolated' })
  assert.deepEqual(getRetainedNativeWorkspaceIds(), [id])
  assert.equal(workspaceStorageKey('ensync-workspace-snapshot-v3', identity), `ensync-native-workspace:${id}:ensync-workspace-snapshot-v3`)
  await assert.rejects(() => initializeNativeWorkspaceIdentity({
    localStorage: storage,
    ensyncDesktop: { getWorkspaceIdentity: async () => ({ id: 'user-key', kind: 'isolated', retainedWorkspaceIds: ['user-key'] }) },
  }))
})

test('browser mode alone uses canonical unsuffixed storage', async () => {
  const identity = await initializeNativeWorkspaceIdentity({})
  assert.equal(isCanonicalWorkspace(identity), true)
  assert.deepEqual(getRetainedNativeWorkspaceIds(), [])
  assert.equal(workspaceStorageKey('ensync-workspace-snapshot-v3', identity), 'ensync-workspace-snapshot-v3')
})

test('mixed-version native renderer fails closed instead of sharing canonical storage', async () => {
  const exactError = new Error(
    "Error invoking remote method 'ensync:workspace:get-identity': No handler registered for 'ensync:workspace:get-identity'",
  )
  let attempts = 0
  await assert.rejects(() => initializeNativeWorkspaceIdentity({
    localStorage: storageFrom([]),
    ensyncDesktop: {
      getWorkspaceIdentity: async () => {
        attempts += 1
        throw exactError
      },
    },
  }, {
    missingHandlerAttempts: 2,
    missingHandlerRetryMs: 0,
    wait: async () => {},
  }), /Quit Ensync completely/)
  assert.equal(attempts, 2)
  assert.equal(isMissingWorkspaceIdentityHandlerError(exactError), true)

  await assert.rejects(() => initializeNativeWorkspaceIdentity({
    localStorage: storageFrom([]),
    ensyncDesktop: {
      getWorkspaceIdentity: async () => {
        throw new Error("Permission denied before No handler registered for 'ensync:workspace:get-identity'")
      },
    },
  }), /Permission denied/)
  assert.equal(isMissingWorkspaceIdentityHandlerError(new Error('No handler registered for another channel')), false)
})

test('an Electron renderer without the identity preload fails closed while web development remains canonical', async () => {
  await assert.rejects(() => initializeNativeWorkspaceIdentity({
    navigator: { userAgent: 'Mozilla/5.0 Ensync Electron/43.3.0' },
    localStorage: storageFrom([]),
  }), /older native bridge/)

  const identity = await initializeNativeWorkspaceIdentity({
    navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0' },
    localStorage: storageFrom([]),
  })
  assert.equal(isCanonicalWorkspace(identity), true)
})

test('mixed-version retry still accepts a handler that appears during startup', async () => {
  const id = '33333333-3333-4333-8333-333333333333'
  let attempts = 0
  const identity = await initializeNativeWorkspaceIdentity({
    localStorage: storageFrom([]),
    ensyncDesktop: {
      getWorkspaceIdentity: async () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error("No handler registered for 'ensync:workspace:get-identity'")
        }
        return { id, kind: 'isolated', retainedWorkspaceIds: [id] }
      },
    },
  }, {
    missingHandlerAttempts: 2,
    missingHandlerRetryMs: 0,
    wait: async () => {},
  })
  assert.deepEqual(identity, { id, kind: 'isolated' })
})

test('trusted retained identities clean only abandoned isolated namespaces', () => {
  const retained = '11111111-1111-4111-8111-111111111111'
  const abandoned = '22222222-2222-4222-8222-222222222222'
  const storage = storageFrom([
    [`ensync-native-workspace:${retained}:ensync-workspace-snapshot-v3`, 'keep'],
    [`ensync-native-workspace:${abandoned}:ensync-workspace-snapshot-v3`, 'remove'],
    ['ensync-workspace-snapshot-v3', 'canonical'],
    ['unrelated', 'keep'],
  ])
  assert.equal(removeAbandonedNativeWorkspaceStorage(storage, [retained]), 1)
  assert.deepEqual([...storage.values.keys()], [
    `ensync-native-workspace:${retained}:ensync-workspace-snapshot-v3`,
    'ensync-workspace-snapshot-v3',
    'unrelated',
  ])
})

test('identity bootstrap preserves abandoned namespaces for recovery', async () => {
  const retained = '11111111-1111-4111-8111-111111111111'
  const abandoned = '22222222-2222-4222-8222-222222222222'
  const storage = storageFrom([
    [`ensync-native-workspace:${retained}:ensync-workspace-snapshot-v3`, 'retained'],
    [`ensync-native-workspace:${abandoned}:ensync-workspace-snapshot-v3`, 'historical'],
    ['ensync-workspace-snapshot-v3', 'canonical'],
  ])
  await initializeNativeWorkspaceIdentity({
    localStorage: storage,
    ensyncDesktop: {
      getWorkspaceIdentity: async () => ({ id: retained, kind: 'isolated', retainedWorkspaceIds: [retained] }),
    },
  })
  assert.equal(storage.values.get(`ensync-native-workspace:${abandoned}:ensync-workspace-snapshot-v3`), 'historical')
})

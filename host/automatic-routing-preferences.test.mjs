import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FALLBACK_PROVIDER_ORDER_KEY,
  readStoredFallbackProviderOrder,
  resolveFallbackProviderOrder,
  subscribeStoredFallbackProviderOrder,
  writeStoredFallbackProviderOrder,
} from '../src/lib/automaticRoutingPreferences.mjs'
import {
  DEFAULT_FALLBACK_PROVIDER_ORDER,
  selectAutomaticProvider,
} from '../src/lib/automaticRouting.mjs'

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: (key) => { values.delete(key) },
    keys: () => [...values.keys()],
  }
}

function chatProvider(id, usage) {
  return { id, connected: true, chatExecution: 'supported', usage }
}

test('the saved ranking uses one device-wide key every native window can read', () => {
  assert.equal(FALLBACK_PROVIDER_ORDER_KEY.includes('ensync-native-workspace:'), false)
  const storage = fakeStorage()
  writeStoredFallbackProviderOrder(storage, ['claude', 'codex'])
  assert.deepEqual(storage.keys(), [FALLBACK_PROVIDER_ORDER_KEY])
  assert.deepEqual(readStoredFallbackProviderOrder(storage), ['claude', 'codex'])
})

test('an unset device store reports no explicit choice instead of the default', () => {
  assert.equal(readStoredFallbackProviderOrder(fakeStorage()), null)
  assert.equal(readStoredFallbackProviderOrder(fakeStorage({ [FALLBACK_PROVIDER_ORDER_KEY]: '{' })), null)
  assert.equal(readStoredFallbackProviderOrder(fakeStorage({ [FALLBACK_PROVIDER_ORDER_KEY]: '"codex"' })), null)
  assert.equal(readStoredFallbackProviderOrder(null), null)
})

test('a stored ranking is normalized to the tested automatic runners', () => {
  const storage = fakeStorage()
  writeStoredFallbackProviderOrder(storage, ['claude', 'gemini', 'claude'])
  assert.deepEqual(readStoredFallbackProviderOrder(storage), ['claude', 'codex'])
})

test('the device-wide ranking wins over another window stale workspace snapshot', () => {
  const storage = fakeStorage({ [FALLBACK_PROVIDER_ORDER_KEY]: JSON.stringify(['claude', 'codex']) })
  assert.deepEqual(resolveFallbackProviderOrder(storage, ['codex', 'claude']), ['claude', 'codex'])
})

test('an explicit workspace ranking migrates once into the device store', () => {
  const storage = fakeStorage()
  assert.deepEqual(resolveFallbackProviderOrder(storage, ['claude', 'codex']), ['claude', 'codex'])
  assert.deepEqual(readStoredFallbackProviderOrder(storage), ['claude', 'codex'])
})

test('a workspace snapshot still holding the default never claims the device store', () => {
  const storage = fakeStorage()
  assert.deepEqual(
    resolveFallbackProviderOrder(storage, [...DEFAULT_FALLBACK_PROVIDER_ORDER]),
    [...DEFAULT_FALLBACK_PROVIDER_ORDER],
  )
  assert.equal(readStoredFallbackProviderOrder(storage), null)
  assert.deepEqual(resolveFallbackProviderOrder(storage, undefined), [...DEFAULT_FALLBACK_PROVIDER_ORDER])
  assert.equal(readStoredFallbackProviderOrder(storage), null)
})

test('a second window ranking change reroutes Auto to Claude Code in every window', () => {
  const nadlanDeskWindow = fakeStorage()
  const relayWindow = nadlanDeskWindow
  const installed = [chatProvider('codex', 12), chatProvider('claude', 3)]

  assert.equal(
    selectAutomaticProvider(installed, resolveFallbackProviderOrder(nadlanDeskWindow, ['codex', 'claude'])).id,
    'codex',
  )

  writeStoredFallbackProviderOrder(relayWindow, ['claude', 'codex'])

  assert.equal(
    selectAutomaticProvider(installed, resolveFallbackProviderOrder(nadlanDeskWindow, ['codex', 'claude'])).id,
    'claude',
  )
})

test('an already-open project adopts a ranking saved by another window', () => {
  const storage = fakeStorage()
  let storageListener = null
  const target = {
    addEventListener: (type, listener) => {
      if (type === 'storage') storageListener = listener
    },
    removeEventListener: (type, listener) => {
      if (type === 'storage' && storageListener === listener) storageListener = null
    },
  }
  const observed = []
  const unsubscribe = subscribeStoredFallbackProviderOrder(
    target,
    storage,
    (order) => observed.push(order),
  )

  writeStoredFallbackProviderOrder(storage, ['claude', 'codex'])
  storageListener?.({ storageArea: storage, key: FALLBACK_PROVIDER_ORDER_KEY })

  assert.deepEqual(observed, [['claude', 'codex']])
  unsubscribe()
  assert.equal(storageListener, null)
})

test('subscription reconciles a ranking changed after startup read but before listener setup', () => {
  const storage = fakeStorage()
  assert.deepEqual(
    resolveFallbackProviderOrder(storage, ['codex', 'claude']),
    ['codex', 'claude'],
  )
  writeStoredFallbackProviderOrder(storage, ['claude', 'codex'])

  const target = {
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const observed = []
  subscribeStoredFallbackProviderOrder(target, storage, (order) => observed.push(order))

  assert.deepEqual(observed, [['claude', 'codex']])
})

test('a read-only or full device store never breaks routing', () => {
  const storage = {
    getItem: () => { throw new Error('storage disabled') },
    setItem: () => { throw new Error('storage disabled') },
  }
  assert.equal(readStoredFallbackProviderOrder(storage), null)
  assert.deepEqual(writeStoredFallbackProviderOrder(storage, ['claude', 'codex']), ['claude', 'codex'])
  assert.deepEqual(resolveFallbackProviderOrder(storage, ['claude', 'codex']), ['claude', 'codex'])
})

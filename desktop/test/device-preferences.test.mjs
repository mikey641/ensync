import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createDevicePreferencesHandlers,
  createDevicePreferencesStore,
} from '../src/device-preferences.mjs'

const spoken = Object.freeze({
  mode: 'speech',
  speechText: 'Your Ensync task is finished.',
  voiceId: '["Samantha","en-US"]',
})

test('device preferences persist spoken completion alerts across store restarts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-device-preferences-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'device-preferences-v1.json')

  const first = createDevicePreferencesStore({ filePath, now: () => '2026-08-07T12:00:00.000Z' })
  assert.deepEqual(first.get(), { completionNotifications: null, updateChannel: 'stable' })
  assert.deepEqual(first.setCompletionNotifications(spoken), {
    completionNotifications: spoken,
    updateChannel: 'stable',
  })

  const restored = createDevicePreferencesStore({ filePath })
  assert.deepEqual(restored.get(), { completionNotifications: spoken, updateChannel: 'stable' })
  const envelope = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal(envelope.format, 'ensync-device-preferences')
  assert.equal(envelope.version, 1)
})

test('device preferences recover the last valid backup after primary corruption', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-device-preferences-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'device-preferences-v1.json')
  const store = createDevicePreferencesStore({ filePath })
  store.setCompletionNotifications(spoken)
  store.setCompletionNotifications({ ...spoken, speechText: 'Done.' })
  await writeFile(filePath, '{corrupt', 'utf8')

  assert.deepEqual(createDevicePreferencesStore({ filePath }).get(), {
    completionNotifications: spoken,
    updateChannel: 'stable',
  })
})

test('device preferences persist an explicit beta channel without dropping completion alerts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-device-preferences-channel-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'device-preferences-v1.json')
  const store = createDevicePreferencesStore({ filePath })

  store.setCompletionNotifications(spoken)
  assert.deepEqual(store.setUpdateChannel('beta'), {
    completionNotifications: spoken,
    updateChannel: 'beta',
  })
  assert.deepEqual(createDevicePreferencesStore({ filePath }).get(), {
    completionNotifications: spoken,
    updateChannel: 'beta',
  })
  assert.throws(() => store.setUpdateChannel('nightly'), /stable or beta/)
})

test('device preference handlers reject unauthorized renderers and malformed settings', () => {
  const event = { sender: { id: 7 } }
  const store = {
    get: () => ({ completionNotifications: spoken, updateChannel: 'stable' }),
    setCompletionNotifications: (settings) => ({ completionNotifications: settings, updateChannel: 'stable' }),
    setUpdateChannel: (updateChannel) => ({ completionNotifications: spoken, updateChannel }),
  }
  const handlers = createDevicePreferencesHandlers({
    isAuthorized: (candidate) => candidate === event,
    store,
  })

  assert.equal(handlers.get({}), null)
  assert.equal(handlers.setCompletionNotifications({}, spoken), null)
  assert.equal(handlers.setUpdateChannel({}, 'beta'), null)
  assert.deepEqual(handlers.get(event), { completionNotifications: spoken, updateChannel: 'stable' })
  assert.deepEqual(handlers.setCompletionNotifications(event, spoken), {
    completionNotifications: spoken,
    updateChannel: 'stable',
  })
  assert.deepEqual(handlers.setUpdateChannel(event, 'beta'), {
    completionNotifications: spoken,
    updateChannel: 'beta',
  })

  const realStore = createDevicePreferencesStore({ filePath: join(tmpdir(), 'unused-ensync-device-preferences.json') })
  assert.throws(() => realStore.setCompletionNotifications({ mode: 'speech' }), /Valid completion/)
})

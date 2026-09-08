import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  answerAlerts: true,
  answerSpeechText: 'Your Ensync task needs an answer.',
  productionAlerts: true,
  productionSpeechText: 'Your Ensync delivery is ready in production.',
})

function publicPreferences(completionNotifications, updateChannel = 'stable', syncServiceUrl = null) {
  return { completionNotifications, updateChannel, syncServiceUrl }
}

test('a device preference file written before question alerts still loads, with them on', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-device-preferences-legacy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'device-preferences-v1.json')
  const payload = JSON.stringify({
    completionNotifications: {
      mode: 'speech',
      speechText: 'Your Ensync task is finished.',
      voiceId: '["Samantha","en-US"]',
    },
    updateChannel: 'stable',
  })
  await writeFile(filePath, JSON.stringify({
    format: 'ensync-device-preferences',
    version: 1,
    revision: 4,
    committedAt: '2026-08-07T12:00:00.000Z',
    payload,
    checksum: createHash('sha256').update(payload).digest('hex'),
  }), 'utf8')

  assert.deepEqual(createDevicePreferencesStore({ filePath }).get(), publicPreferences(spoken))
})

test('a device keeps question alerts switched off across store restarts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-device-preferences-answer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'device-preferences-v1.json')
  const silentQuestions = { ...spoken, answerAlerts: false }

  createDevicePreferencesStore({ filePath }).setCompletionNotifications(silentQuestions)

  assert.deepEqual(createDevicePreferencesStore({ filePath }).get(), publicPreferences(silentQuestions))
})

test('a device keeps Production-ready alerts switched off across store restarts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-device-preferences-production-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'device-preferences-v1.json')
  const silentProduction = { ...spoken, productionAlerts: false }

  createDevicePreferencesStore({ filePath }).setCompletionNotifications(silentProduction)

  assert.deepEqual(
    createDevicePreferencesStore({ filePath }).get(),
    publicPreferences(silentProduction),
  )
})

test('device preferences persist spoken completion alerts across store restarts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-device-preferences-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'device-preferences-v1.json')

  const first = createDevicePreferencesStore({ filePath, now: () => '2026-08-07T12:00:00.000Z' })
  assert.deepEqual(first.get(), publicPreferences(null))
  assert.deepEqual(first.setCompletionNotifications(spoken), publicPreferences(spoken))

  const restored = createDevicePreferencesStore({ filePath })
  assert.deepEqual(restored.get(), publicPreferences(spoken))
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

  assert.deepEqual(createDevicePreferencesStore({ filePath }).get(), publicPreferences(spoken))
})

test('device preferences persist an explicit beta channel without dropping completion alerts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-device-preferences-channel-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'device-preferences-v1.json')
  const store = createDevicePreferencesStore({ filePath })

  store.setCompletionNotifications(spoken)
  assert.deepEqual(store.setUpdateChannel('beta'), publicPreferences(spoken, 'beta'))
  assert.deepEqual(createDevicePreferencesStore({ filePath }).get(), publicPreferences(spoken, 'beta'))
  assert.throws(() => store.setUpdateChannel('nightly'), /stable or beta/)
})

test('device preferences persist an explicit Sync service URL and clear it again', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-device-preferences-sync-url-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'device-preferences-v1.json')
  const store = createDevicePreferencesStore({ filePath })

  assert.deepEqual(store.setSyncServiceUrl('https://sync.example.com/'), {
    completionNotifications: null,
    updateChannel: 'stable',
    syncServiceUrl: 'https://sync.example.com',
  })
  assert.deepEqual(createDevicePreferencesStore({ filePath }).get(), {
    completionNotifications: null,
    updateChannel: 'stable',
    syncServiceUrl: 'https://sync.example.com',
  })

  store.setSyncServiceUrl('')
  assert.equal(createDevicePreferencesStore({ filePath }).get().syncServiceUrl, null)
})

test('invalid Sync service URLs are rejected instead of persisted', () => {
  const store = createDevicePreferencesStore({ filePath: join(tmpdir(), 'unused-ensync-sync-url.json') })
  assert.throws(() => store.setSyncServiceUrl('https://sync.example.com/path?token=1'), /HTTPS URL/)
  assert.throws(() => store.setSyncServiceUrl('http://public.example.com'), /HTTPS URL/)
  assert.throws(() => store.setSyncServiceUrl('not a url'), /HTTPS URL/)
  // Exact loopback HTTP is the local bundled service and remains allowed.
  assert.equal(store.setSyncServiceUrl('http://127.0.0.1:43122/').syncServiceUrl, 'http://127.0.0.1:43122')
})

test('device preference handlers reject unauthorized renderers and malformed settings', () => {
  const event = { sender: { id: 7 } }
  const store = {
    get: () => publicPreferences(spoken),
    setCompletionNotifications: (settings) => publicPreferences(settings),
    setUpdateChannel: (updateChannel) => publicPreferences(spoken, updateChannel),
    setSyncServiceUrl: (syncServiceUrl) => publicPreferences(spoken, 'stable', syncServiceUrl),
  }
  const handlers = createDevicePreferencesHandlers({
    isAuthorized: (candidate) => candidate === event,
    store,
  })

  assert.equal(handlers.get({}), null)
  assert.equal(handlers.setCompletionNotifications({}, spoken), null)
  assert.equal(handlers.setUpdateChannel({}, 'beta'), null)
  assert.equal(handlers.setSyncServiceUrl({}, 'https://sync.example.com'), null)
  assert.deepEqual(handlers.get(event), publicPreferences(spoken))
  assert.deepEqual(handlers.setCompletionNotifications(event, spoken), publicPreferences(spoken))
  assert.deepEqual(handlers.setUpdateChannel(event, 'beta'), publicPreferences(spoken, 'beta'))
  assert.deepEqual(
    handlers.setSyncServiceUrl(event, 'https://sync.example.com'),
    publicPreferences(spoken, 'stable', 'https://sync.example.com'),
  )

  const realStore = createDevicePreferencesStore({ filePath: join(tmpdir(), 'unused-ensync-device-preferences.json') })
  assert.throws(() => realStore.setCompletionNotifications({ mode: 'speech' }), /Valid completion/)
})

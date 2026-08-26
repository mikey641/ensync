import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPLETION_NOTIFICATIONS_STORAGE_KEY,
  initializeCompletionNotificationPreferences,
  readCompletionNotificationSettings,
  saveCompletionNotificationPreferences,
} from '../src/lib/completionNotificationPreferences.mjs'

function storage(entries = []) {
  const values = new Map(entries)
  return {
    values,
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, String(value)) },
  }
}

const spoken = Object.freeze({
  mode: 'speech',
  speechText: 'Your Ensync task is finished.',
  voiceId: '["Samantha","en-US"]',
  answerAlerts: true,
  answerSpeechText: 'Your Ensync task needs an answer.',
})

test('preferences saved before question alerts existed gain them, switched on', () => {
  const localStorage = storage([
    [COMPLETION_NOTIFICATIONS_STORAGE_KEY, JSON.stringify({
      mode: 'ringtone',
      speechText: 'All done.',
      voiceId: null,
    })],
  ])

  assert.deepEqual(readCompletionNotificationSettings(localStorage), {
    mode: 'ringtone',
    speechText: 'All done.',
    voiceId: null,
    answerAlerts: true,
    answerSpeechText: 'Your Ensync task needs an answer.',
  })
})

test('turning question alerts off round-trips through browser storage', () => {
  const localStorage = storage()
  const saved = saveCompletionNotificationPreferences({ ...spoken, answerAlerts: false }, { localStorage })

  assert.equal(saved.answerAlerts, false)
  assert.equal(readCompletionNotificationSettings(localStorage).answerAlerts, false)
})

test('spoken completion preferences round-trip through browser storage', () => {
  const localStorage = storage()
  const saved = saveCompletionNotificationPreferences(spoken, { localStorage })

  assert.deepEqual(saved, spoken)
  assert.deepEqual(readCompletionNotificationSettings(localStorage), spoken)
})

test('native initialization migrates the existing renderer preference once', async () => {
  const localStorage = storage([
    [COMPLETION_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(spoken)],
  ])
  const migrated = []
  const result = await initializeCompletionNotificationPreferences({
    localStorage,
    ensyncDesktop: {
      getDevicePreferences: async () => ({ completionNotifications: null }),
      setCompletionNotificationPreferences: async (settings) => {
        migrated.push(settings)
        return { completionNotifications: settings }
      },
    },
  })

  assert.deepEqual(result, spoken)
  assert.deepEqual(migrated, [spoken])
})

test('native completion preference restores spoken text after renderer storage resets', async () => {
  const localStorage = storage()
  const result = await initializeCompletionNotificationPreferences({
    localStorage,
    ensyncDesktop: {
      getDevicePreferences: async () => ({ completionNotifications: spoken }),
      setCompletionNotificationPreferences: async () => assert.fail('native preference should already exist'),
    },
  })

  assert.deepEqual(result, spoken)
  assert.deepEqual(readCompletionNotificationSettings(localStorage), spoken)
})

test('saving a renderer preference also commits it to the device bridge', async () => {
  const localStorage = storage()
  const committed = []
  saveCompletionNotificationPreferences(spoken, {
    localStorage,
    ensyncDesktop: {
      getDevicePreferences: async () => ({ completionNotifications: null }),
      setCompletionNotificationPreferences: async (settings) => committed.push(settings),
    },
  })
  await Promise.resolve()

  assert.deepEqual(committed, [spoken])
})

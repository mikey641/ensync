import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_UPDATE_INTERVAL_MS,
  acknowledgeAgentUpdateReminder,
  agentUpdateDue,
  normalizeAgentUpdatePreferences,
  readAgentUpdatePreferences,
  recordAgentUpdateMaintenance,
  writeAgentUpdatePreferences,
} from '../src/lib/agentUpdatePreferences.mjs'

function memoryStorage(initial = null) {
  let value = initial
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next },
    value: () => value,
  }
}

test('agent update preferences default to a truthful non-mutating reminder', () => {
  assert.deepEqual(normalizeAgentUpdatePreferences(null), {
    mode: 'remind',
    lastReminderAt: null,
    lastMaintenanceAt: null,
  })
  assert.equal(agentUpdateDue(null, Date.UTC(2026, 7, 7)), true)
})

test('weekly reminder and automatic maintenance use separate factual anchors', () => {
  const now = Date.UTC(2026, 7, 7)
  const recent = new Date(now - AGENT_UPDATE_INTERVAL_MS + 1).toISOString()
  const stale = new Date(now - AGENT_UPDATE_INTERVAL_MS).toISOString()

  assert.equal(agentUpdateDue({ mode: 'remind', lastReminderAt: recent }, now), false)
  assert.equal(agentUpdateDue({ mode: 'remind', lastReminderAt: stale }, now), true)
  assert.equal(agentUpdateDue({ mode: 'automatic', lastReminderAt: recent, lastMaintenanceAt: null }, now), true)
  assert.equal(agentUpdateDue({ mode: 'automatic', lastMaintenanceAt: recent }, now), false)
  assert.equal(agentUpdateDue({ mode: 'manual' }, now), false)
})

test('preference persistence rejects malformed modes and records reviewed maintenance', () => {
  const storage = memoryStorage(JSON.stringify({ mode: 'silent', lastReminderAt: 'not-a-date' }))
  assert.equal(readAgentUpdatePreferences(storage).mode, 'remind')

  const reminded = acknowledgeAgentUpdateReminder({ mode: 'remind' }, '2026-08-07T10:00:00.000Z')
  const maintained = recordAgentUpdateMaintenance(reminded, '2026-08-07T11:00:00.000Z')
  const saved = writeAgentUpdatePreferences(storage, maintained)

  assert.equal(saved.lastReminderAt, '2026-08-07T11:00:00.000Z')
  assert.equal(saved.lastMaintenanceAt, '2026-08-07T11:00:00.000Z')
  assert.deepEqual(readAgentUpdatePreferences(storage), saved)
})

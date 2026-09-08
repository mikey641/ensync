import assert from 'node:assert/strict'
import test from 'node:test'
import { parseQoderStatus } from './qoder-status.mjs'

const CHECKED_AT = '2026-09-07T14:00:00.000Z'

test('parseQoderStatus reads the signed-in account', () => {
  const auth = parseQoderStatus({
    stdout: JSON.stringify({
      logged_in: true,
      version: '1.1.16',
      allow_byok: 0,
      username: 'Mikey Hasson',
      email: 'mikey641@gmail.com',
    }),
    exitCode: 0,
  }, CHECKED_AT)

  assert.equal(auth.state, 'authenticated')
  assert.equal(auth.accountLogin, 'mikey641@gmail.com')
  assert.equal(auth.method, 'Qoder account login')
})

test('parseQoderStatus reports an explicit signed-out state', () => {
  const auth = parseQoderStatus({ stdout: JSON.stringify({ logged_in: false }), exitCode: 0 }, CHECKED_AT)
  assert.equal(auth.state, 'not_authenticated')
  assert.equal(auth.accountLogin, null)
})

test('parseQoderStatus refuses malformed, empty, or failed captures', () => {
  assert.equal(parseQoderStatus({ stdout: 'not json', exitCode: 0 }, CHECKED_AT).state, 'unavailable')
  assert.equal(parseQoderStatus({ stdout: '', exitCode: 0 }, CHECKED_AT).state, 'unavailable')
  assert.equal(parseQoderStatus({ timedOut: true, stdout: '{}' }, CHECKED_AT).state, 'unavailable')
  assert.equal(parseQoderStatus({ error: 'spawn failed', stdout: '{}' }, CHECKED_AT).state, 'unavailable')
  assert.equal(parseQoderStatus(null, CHECKED_AT).state, 'unavailable')
  assert.equal(parseQoderStatus({ stdout: JSON.stringify({ logged_in: true, email: '' }), exitCode: 0 }, CHECKED_AT).state, 'unavailable')
})

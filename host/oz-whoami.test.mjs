import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOzWhoami } from './oz-whoami.mjs'

const CHECKED_AT = '2026-09-07T14:00:00.000Z'

test('parseOzWhoami reads the signed-in account', () => {
  const auth = parseOzWhoami({
    stdout: JSON.stringify({ uid: 'u1', type: 'user', display_name: 'Mikey Hasson', email: 'mikey641@gmail.com' }),
    exitCode: 0,
  }, CHECKED_AT)

  assert.equal(auth.state, 'authenticated')
  assert.equal(auth.accountLogin, 'mikey641@gmail.com')
  assert.equal(auth.method, 'Warp account login')
})

test('parseOzWhoami recognizes a signed-out text message', () => {
  const auth = parseOzWhoami({ stdout: 'Error: not logged in', exitCode: 1 }, CHECKED_AT)
  assert.equal(auth.state, 'not_authenticated')
})

test('parseOzWhoami refuses failed or unrecognized captures', () => {
  assert.equal(parseOzWhoami({ stdout: 'something else', exitCode: 0 }, CHECKED_AT).state, 'unavailable')
  assert.equal(parseOzWhoami({ timedOut: true, stdout: '{}' }, CHECKED_AT).state, 'unavailable')
  assert.equal(parseOzWhoami({ error: 'spawn failed', stdout: '{}' }, CHECKED_AT).state, 'unavailable')
  assert.equal(parseOzWhoami(null, CHECKED_AT).state, 'unavailable')
  assert.equal(parseOzWhoami({ stdout: JSON.stringify({ uid: 'u1', email: '' }), exitCode: 0 }, CHECKED_AT).state, 'unavailable')
})

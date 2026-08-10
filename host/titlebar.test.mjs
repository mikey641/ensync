import assert from 'node:assert/strict'
import test from 'node:test'

import { decorativeTrafficLightsVisible } from '../src/lib/titlebar.mjs'

test('decorative traffic lights render in browser mode', () => {
  assert.equal(decorativeTrafficLightsVisible(undefined), true)
  assert.equal(decorativeTrafficLightsVisible(null), true)
})

test('decorative traffic lights are hidden inside the native shell', () => {
  assert.equal(decorativeTrafficLightsVisible({}), false)
  assert.equal(decorativeTrafficLightsVisible({ getPathForFile: () => '/tmp/file.png' }), false)
})

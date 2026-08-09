import assert from 'node:assert/strict'
import test from 'node:test'

import { PROJECT_COLORS, projectColor } from '../src/lib/projectColors.mjs'

test('project colors are stable across equivalent project paths', () => {
  assert.equal(projectColor('/Users/person/dev/relay/'), projectColor('/Users/person/dev/relay'))
  assert.equal(projectColor('C:\\Work\\Relay\\'), projectColor('c:/Work/Relay'))
})

test('project colors distinguish representative recent projects', () => {
  const colors = [
    '/Users/person/dev/relay',
    '/Users/person/dev/nadlan-desk',
    '/Users/person/dev/marketing-site',
    '/Users/person/dev/internal-tools',
  ].map(projectColor)

  assert.equal(new Set(colors).size, colors.length)
  assert.equal(colors.every((color) => PROJECT_COLORS.includes(color)), true)
})

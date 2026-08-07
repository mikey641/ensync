import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chooseNativeProjectFolder,
  nativeProjectFolderPickerAvailable,
} from '../src/lib/nativeProjectFolder.mjs'

test('native project folder helper degrades to manual input outside the desktop app', async () => {
  assert.equal(nativeProjectFolderPickerAvailable({}), false)
  const result = await chooseNativeProjectFolder({})
  assert.equal(result.status, 'unavailable')
  assert.match(result.message, /Enter an absolute path/)
})

test('native project folder helper preserves selection and cancellation', async () => {
  const selectedBridge = {
    ensyncDesktop: {
      chooseProjectFolder: async () => ({ status: 'selected', path: '/tmp/ensync-project' }),
    },
  }
  assert.equal(nativeProjectFolderPickerAvailable(selectedBridge), true)
  assert.deepEqual(await chooseNativeProjectFolder(selectedBridge), {
    status: 'selected',
    path: '/tmp/ensync-project',
  })

  const cancelledBridge = {
    ensyncDesktop: {
      chooseProjectFolder: async () => ({ status: 'cancelled' }),
    },
  }
  assert.deepEqual(await chooseNativeProjectFolder(cancelledBridge), { status: 'cancelled' })
})

test('native project folder helper reports malformed or rejected bridge results honestly', async () => {
  const malformed = {
    ensyncDesktop: { chooseProjectFolder: async () => ({ status: 'selected' }) },
  }
  const rejected = {
    ensyncDesktop: { chooseProjectFolder: async () => { throw new Error('ipc failed') } },
  }

  assert.equal((await chooseNativeProjectFolder(malformed)).status, 'error')
  assert.equal((await chooseNativeProjectFolder(rejected)).status, 'error')
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { launchDetachedElectron } from '../src/detached-launch.mjs'

test('the source-tree launcher detaches Electron from temporary terminal sessions', async () => {
  let invocation
  let unrefCalled = false
  const child = new EventEmitter()
  child.pid = 42_424
  child.unref = () => { unrefCalled = true }
  const spawnImpl = (executable, args, options) => {
    invocation = { executable, args, options }
    queueMicrotask(() => child.emit('spawn'))
    return child
  }

  const result = await launchDetachedElectron({
    electronPath: '/tools/electron',
    appPath: '/project/desktop',
    cwd: '/project/desktop',
    environment: { ENSYNC_TEST: '1' },
    spawnImpl,
  })

  assert.deepEqual(result, { pid: 42_424 })
  assert.equal(unrefCalled, true)
  assert.deepEqual(invocation, {
    executable: '/tools/electron',
    args: ['/project/desktop'],
    options: {
      cwd: '/project/desktop',
      detached: true,
      env: { ENSYNC_TEST: '1' },
      shell: false,
      stdio: 'ignore',
      windowsHide: false,
    },
  })
})

test('the source-tree launcher reports a spawn failure instead of claiming the app opened', async () => {
  const failure = new Error('could not spawn Electron')
  const child = new EventEmitter()
  child.unref = () => assert.fail('a failed child must not be unreferenced as launched')
  const launching = launchDetachedElectron({
    electronPath: 'electron',
    appPath: 'desktop',
    cwd: '/project',
    spawnImpl: () => {
      queueMicrotask(() => child.emit('error', failure))
      return child
    },
  })

  await assert.rejects(launching, failure)
})

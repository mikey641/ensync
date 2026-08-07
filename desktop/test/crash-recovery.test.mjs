import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRendererCrashRecovery,
  isRecoverableRendererExit,
} from '../src/crash-recovery.mjs'
import { createNativeWindowRegistry } from '../src/native-windows.mjs'

test('renderer crash recovery ignores clean exits and bounds repeated reloads', () => {
  let now = 1_000
  const recovery = createRendererCrashRecovery({ now: () => now, windowMs: 30_000, maxReloads: 2 })

  assert.equal(isRecoverableRendererExit({ reason: 'clean-exit' }), false)
  assert.equal(recovery.requestReload({ reason: 'clean-exit' }), false)
  assert.equal(recovery.requestReload({ reason: 'crashed' }), true)
  now += 100
  assert.equal(recovery.requestReload({ reason: 'oom' }), true)
  now += 100
  assert.equal(recovery.requestReload({ reason: 'crashed' }), false)

  now += 30_001
  assert.equal(recovery.requestReload({ reason: 'crashed' }), true)
  recovery.dispose()
})

test('a renderer must remain loaded for the recovery window before the loop counter resets', () => {
  let now = 10_000
  let timer = null
  const recovery = createRendererCrashRecovery({
    now: () => now,
    windowMs: 5_000,
    maxReloads: 1,
    setTimeout(callback) { timer = callback; return 1 },
    clearTimeout() { timer = null },
  })

  assert.equal(recovery.requestReload({ reason: 'crashed' }), true)
  recovery.rendererLoaded()
  assert.equal(recovery.requestReload({ reason: 'crashed' }), false)
  recovery.rendererLoaded()
  assert.ok(timer)
  timer()
  assert.equal(recovery.requestReload({ reason: 'crashed' }), true)
})

test('renderer crash recovery retains the BrowserWindow workspace identity', () => {
  const window = {
    destroyed: false,
    webContents: {},
    isDestroyed() { return this.destroyed },
  }
  const identity = { id: '33333333-3333-4333-8333-333333333333', kind: 'isolated' }
  const registry = createNativeWindowRegistry()
  const recovery = createRendererCrashRecovery()
  registry.add(window, identity)

  assert.equal(recovery.requestReload({ reason: 'crashed' }), true)
  assert.strictEqual(registry.workspaceForWebContents(window.webContents), identity)
  recovery.rendererLoaded()
  assert.strictEqual(registry.workspaceForWebContents(window.webContents), identity)
  recovery.dispose()
})

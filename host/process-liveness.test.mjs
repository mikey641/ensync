import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  PROCESS_IDENTITY_TOLERANCE_MS,
  processIsAlive,
  processIsLiveSince,
  processStartTimeMs,
} from './process-liveness.mjs'

function ownStartTimeMs() {
  return Date.now() - Math.round(process.uptime() * 1000)
}

async function retiredPid() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  const { pid } = child
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  return pid
}

test('the start time reported for this process matches its own uptime', () => {
  const reported = processStartTimeMs(process.pid)
  assert.notEqual(reported, null)
  // `ps` truncates elapsed time to whole seconds, so allow a two second window.
  assert.ok(
    Math.abs(reported - ownStartTimeMs()) < 2_000,
    `reported start ${reported} is not within 2s of ${ownStartTimeMs()}`,
  )
})

test('a record written by a still-running process is judged live', () => {
  assert.equal(processIsLiveSince(process.pid, Date.now()), true)
})

test('a record predating the process that now holds the PID is judged retired', () => {
  // Exactly the reboot case: the PID is alive, but its current owner started
  // long after the record was written, so it cannot be the writer.
  const beforeThisProcessStarted = ownStartTimeMs() - 600_000
  assert.equal(processIsLiveSince(process.pid, beforeThisProcessStarted), false)
})

test('a PID with no live process is judged retired', async () => {
  const pid = await retiredPid()
  assert.equal(processIsAlive(pid), false)
  assert.equal(processIsLiveSince(pid, Date.now()), false)
})

test('a record with no usable timestamp keeps the live PID fenced', () => {
  // Without a timestamp there is no evidence the PID was recycled, and wrongly
  // declaring a live writer dead lets two Hosts write one file.
  assert.equal(processIsLiveSince(process.pid, null), true)
  assert.equal(processIsLiveSince(process.pid, Number.NaN), true)
})

test('the identity tolerance decides records straddling the process start', () => {
  const started = ownStartTimeMs()
  assert.equal(processIsLiveSince(process.pid, started - (PROCESS_IDENTITY_TOLERANCE_MS - 5_000)), true)
  assert.equal(processIsLiveSince(process.pid, started - (PROCESS_IDENTITY_TOLERANCE_MS + 5_000)), false)
})

test('the desktop copy of this module is identical to the shipped one', async () => {
  // desktop/src cannot import host/: electron-builder packs it into app.asar
  // while host/ is rsynced beside it, so the import would resolve in a dev
  // checkout and fail only once installed. The copy is therefore load bearing,
  // and it is only safe while it stays byte-identical below its header.
  const [shipped, desktopCopy] = await Promise.all([
    readFile(join(import.meta.dirname, 'process-liveness.mjs'), 'utf8'),
    readFile(join(import.meta.dirname, '..', 'desktop', 'src', 'process-liveness.mjs'), 'utf8'),
  ])
  assert.ok(
    desktopCopy.endsWith(shipped),
    'desktop/src/process-liveness.mjs has drifted from host/process-liveness.mjs',
  )
})

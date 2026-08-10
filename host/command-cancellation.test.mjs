import assert from 'node:assert/strict'
import test from 'node:test'

import { runProcess } from './command.mjs'

test('process cancellation is bounded even when the child ignores graceful termination', async () => {
  const controller = new AbortController()
  const startedAt = Date.now()
  const resultPromise = runProcess(
    process.execPath,
    ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    {
      signal: controller.signal,
      timeoutMs: 5_000,
      terminationGraceMs: 50,
    },
  )
  setTimeout(() => controller.abort(), 75)

  const result = await resultPromise
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
  assert.ok(Date.now() - startedAt < 2_000)
  assert.notEqual(result.exitCode, 0)
})

test('process inactivity watchdog refreshes on real stdout and stderr progress', async () => {
  const script = [
    'let count = 0;',
    'process.stdout.write(".");',
    'const timer = setInterval(() => {',
    '  count += 1;',
    '  (count % 2 ? process.stdout : process.stderr).write(".");',
    '  if (count === 24) { clearInterval(timer); process.exit(0); }',
    '}, 100);',
  ].join('')
  const result = await runProcess(process.execPath, ['-e', script], {
    inactivityTimeoutMs: 1_500,
    hardTimeoutMs: 5_000,
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.timeoutReason, null)
  assert.equal(`${result.stdout}${result.stderr}`.length, 25)
})

test('an explicit null hard timeout disables the legacy wall-clock deadline', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write("finished"), 125)'],
    {
      timeoutMs: 25,
      inactivityTimeoutMs: 1_000,
      hardTimeoutMs: null,
    },
  )

  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.timeoutReason, null)
  assert.equal(result.stdout, 'finished')
})

test('process reports inactivity separately from its hard ceiling', async () => {
  const inactive = await runProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    {
      inactivityTimeoutMs: 50,
      hardTimeoutMs: 1_000,
      terminationGraceMs: 25,
    },
  )
  assert.equal(inactive.timedOut, true)
  assert.equal(inactive.timeoutReason, 'inactivity')
  assert.equal(inactive.aborted, false)

  const active = await runProcess(
    process.execPath,
    ['-e', 'setInterval(() => process.stdout.write("."), 20)'],
    {
      inactivityTimeoutMs: 1_000,
      hardTimeoutMs: 300,
      terminationGraceMs: 25,
    },
  )
  assert.equal(active.timedOut, true)
  assert.equal(active.timeoutReason, 'hard_limit')
  assert.equal(active.aborted, false)
})

test('process capture reports when provider output was truncated', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("123456789")'],
    { maxCaptureBytes: 5 },
  )

  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, '12345')
  assert.equal(result.outputTruncated, true)
})

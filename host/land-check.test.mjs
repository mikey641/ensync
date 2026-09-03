import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runLandCheck, runLandQuickCheck } from './land-check.mjs'

async function repositoryFixture(context, scripts) {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'relay-land-check-test-'))
  context.after(() => rm(repositoryPath, { recursive: true, force: true }))
  if (scripts !== null) {
    await writeFile(join(repositoryPath, 'package.json'), JSON.stringify({ name: 'fixture', scripts }))
  }
  return repositoryPath
}

test('a repository without a land:check script skips verification and lands', async (context) => {
  const repositoryPath = await repositoryFixture(context, { build: 'vite build' })
  const result = await runLandCheck(repositoryPath, {
    processRunner: async () => { throw new Error('must not run') },
  })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
})

test('a repository without a package.json skips verification and lands', async (context) => {
  const repositoryPath = await repositoryFixture(context, null)
  const result = await runLandCheck(repositoryPath, {
    processRunner: async () => { throw new Error('must not run') },
  })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
})

test('a passing land:check script verifies the land', async (context) => {
  const repositoryPath = await repositoryFixture(context, { 'land:check': 'tsc --noEmit' })
  const calls = []
  const result = await runLandCheck(repositoryPath, {
    processRunner: async (executable, args, options) => {
      calls.push({ executable, args, cwd: options.cwd })
      return { exitCode: 0, error: null, timedOut: false, stdout: 'ok\n', stderr: '' }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, undefined)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['run', 'land:check'])
  assert.equal(calls[0].cwd, repositoryPath)
})

test('a failing land:check script fails the land with its output', async (context) => {
  const repositoryPath = await repositoryFixture(context, { 'land:check': 'tsc --noEmit' })
  const result = await runLandCheck(repositoryPath, {
    processRunner: async () => ({
      exitCode: 2,
      error: null,
      timedOut: false,
      stdout: "src/App.tsx(3419,8): error TS2304: Cannot find name 'viewedFilePath'.\n",
      stderr: '',
    }),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /land:check/)
  assert.match(result.output, /TS2304/)
})

test('an unavailable npm skips verification instead of blocking automerge', async (context) => {
  const repositoryPath = await repositoryFixture(context, { 'land:check': 'tsc --noEmit' })
  const result = await runLandCheck(repositoryPath, {
    processRunner: async () => ({ exitCode: null, error: 'spawn npm ENOENT', timedOut: false, stdout: '', stderr: '' }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /could not run/)
})

test('a timed-out land check skips verification instead of blocking automerge', async (context) => {
  const repositoryPath = await repositoryFixture(context, { 'land:check': 'tsc --noEmit' })
  const result = await runLandCheck(repositoryPath, {
    processRunner: async () => ({ exitCode: null, error: null, timedOut: true, timeoutReason: 'hard_limit', stdout: '', stderr: '' }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /did not finish/)
})

test('land:quick is optional but runs once with a short bounded gate when present', async (context) => {
  const repositoryPath = await repositoryFixture(context, { 'land:quick': 'npm test -- --quick' })
  const calls = []
  const result = await runLandQuickCheck(repositoryPath, {
    processRunner: async (executable, args, options) => {
      calls.push({ executable, args, options })
      return { exitCode: 0, error: null, timedOut: false, stdout: '', stderr: '' }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['run', 'land:quick'])
  assert.ok(calls[0].options.hardTimeoutMs < 5 * 60_000)
})

test('an unavailable or timed-out land:quick gate fails closed', async (context) => {
  const repositoryPath = await repositoryFixture(context, { 'land:quick': 'npm test -- --quick' })
  const unavailable = await runLandQuickCheck(repositoryPath, {
    processRunner: async () => ({ exitCode: null, error: 'spawn npm ENOENT', timedOut: false, stdout: '', stderr: '' }),
  })
  const timedOut = await runLandQuickCheck(repositoryPath, {
    processRunner: async () => ({ exitCode: null, error: null, timedOut: true, stdout: '', stderr: '' }),
  })

  assert.equal(unavailable.ok, false)
  assert.equal(timedOut.ok, false)
  assert.match(unavailable.reason, /could not run/)
  assert.match(timedOut.reason, /did not finish/)
})

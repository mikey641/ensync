import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appShellProcessPattern,
  brokerKeepsHostBusy,
  copyIfChanged,
  exportCommit,
  hasActiveLanding,
  hasRunningChatJobs,
  hashFile,
  pathExists,
  performIncrementalUpdate,
  readMainCommit,
  updateHostFiles,
  updateUiFiles,
  waitForProcessExit,
} from '../scripts/app-bundle-update.mjs'
import { runContinuousUpdateCheck } from '../scripts/continuous-update.mjs'

async function makeTempDir(prefix = 'ensync-update-test-') {
  return mkdtemp(join(tmpdir(), prefix))
}

test('hashFile returns null for a missing path and a hex string for an existing one', async () => {
  assert.equal(await hashFile(join(tmpdir(), 'nonexistent-file')), null)
  const dir = await makeTempDir()
  const file = join(dir, 'test.txt')
  await writeFile(file, 'hello')
  const hash = await hashFile(file)
  assert.equal(typeof hash, 'string')
  assert.equal(hash.length, 64)
  await rm(dir, { recursive: true })
})

test('copyIfChanged returns false for identical files and true for changed', async () => {
  const dir = await makeTempDir()
  const src = join(dir, 'src.txt')
  const dest = join(dir, 'dest.txt')

  await writeFile(src, 'same')
  await writeFile(dest, 'same')
  assert.equal(await copyIfChanged(src, dest), false)

  await writeFile(src, 'different')
  assert.equal(await copyIfChanged(src, dest), true)
  assert.equal(await readFile(dest, 'utf8'), 'different')

  await rm(dir, { recursive: true })
})

test('copyIfChanged creates destination directory if missing', async () => {
  const dir = await makeTempDir()
  const src = join(dir, 'src.txt')
  const dest = join(dir, 'nested', 'dest.txt')
  await writeFile(src, 'content')
  assert.equal(await copyIfChanged(src, dest), true)
  assert.equal(await readFile(dest, 'utf8'), 'content')
  await rm(dir, { recursive: true })
})

test('app relaunch targets the Electron shell without matching the detached Host', () => {
  const pattern = new RegExp(appShellProcessPattern('/Applications/Ensync.app'))
  assert.equal(pattern.test('/Applications/Ensync.app/Contents/MacOS/Ensync'), true)
  assert.equal(pattern.test('/Applications/Ensync.app/Contents/MacOS/Ensync /Applications/Ensync.app/Contents/Resources/desktop-host-bootstrap.mjs'), false)
})

test('updateHostFiles copies .mjs files and skips test files and dev.mjs', async (context) => {
  const src = await makeTempDir('ensync-host-src-')
  const dest = await makeTempDir('ensync-host-dest-')
  context.after(() => Promise.all([rm(src, { recursive: true }), rm(dest, { recursive: true })]))

  await writeFile(join(src, 'server.mjs'), 'module.exports = 1')
  await writeFile(join(src, 'chat.mjs'), 'module.exports = 2')
  await writeFile(join(src, 'chat.test.mjs'), 'test')
  await writeFile(join(src, 'dev.mjs'), 'dev')
  await writeFile(join(src, 'readme.md'), 'readme')

  const changed = await updateHostFiles({ src, dest })
  assert.deepEqual(changed.sort(), ['host/chat.mjs', 'host/server.mjs'])

  assert.equal(await pathExists(join(dest, 'chat.test.mjs')), false)
  assert.equal(await pathExists(join(dest, 'dev.mjs')), false)
  assert.equal(await pathExists(join(dest, 'readme.md')), false)
})

test('updateHostFiles reports no changes on a second identical run', async (context) => {
  const src = await makeTempDir('ensync-host-src-')
  const dest = await makeTempDir('ensync-host-dest-')
  context.after(() => Promise.all([rm(src, { recursive: true }), rm(dest, { recursive: true })]))

  await writeFile(join(src, 'server.mjs'), 'module.exports = 1')
  await updateHostFiles({ src, dest })
  const changed = await updateHostFiles({ src, dest })
  assert.deepEqual(changed, [])
})

test('updateUiFiles copies index.html and assets and removes assets the build no longer ships', async (context) => {
  const src = await makeTempDir('ensync-dist-src-')
  const dest = await makeTempDir('ensync-ui-dest-')
  context.after(() => Promise.all([rm(src, { recursive: true }), rm(dest, { recursive: true })]))

  await mkdir(join(src, 'assets'), { recursive: true })
  await writeFile(join(src, 'index.html'), '<html></html>')
  await writeFile(join(src, 'assets', 'App-abc123.js'), 'js')
  await writeFile(join(src, 'assets', 'index-def456.css'), 'css')

  // Seed a stale asset that should be wiped
  await mkdir(join(dest, 'assets'), { recursive: true })
  await writeFile(join(dest, 'assets', 'stale-old.js'), 'old')

  const changed = await updateUiFiles({ build: false, src, dest })
  assert.ok(changed.includes('ui/index.html'))
  assert.ok(changed.some((f) => f.includes('App-abc123.js')))
  assert.ok(changed.some((f) => f.includes('index-def456.css')))

  assert.equal(await pathExists(join(dest, 'assets', 'stale-old.js')), false)
  assert.equal(await readFile(join(dest, 'index.html'), 'utf8'), '<html></html>')
})

test('updateUiFiles leaves an identical build alone so it never restarts the app', async (context) => {
  const src = await makeTempDir('ensync-dist-src-')
  const dest = await makeTempDir('ensync-ui-dest-')
  context.after(() => Promise.all([rm(src, { recursive: true }), rm(dest, { recursive: true })]))

  await mkdir(join(src, 'assets'), { recursive: true })
  await writeFile(join(src, 'index.html'), '<html></html>')
  await writeFile(join(src, 'assets', 'App-abc123.js'), 'js')

  await updateUiFiles({ build: false, src, dest })
  assert.deepEqual(await updateUiFiles({ build: false, src, dest }), [])
  assert.equal(await readFile(join(dest, 'assets', 'App-abc123.js'), 'utf8'), 'js')
})

test('an update exports the committed tree, never uncommitted checkout edits', async (context) => {
  const repo = await makeTempDir('ensync-export-repo-')
  const parent = await makeTempDir('ensync-export-dest-')
  context.after(() => Promise.all([
    rm(repo, { recursive: true, force: true }),
    rm(parent, { recursive: true, force: true }),
  ]))
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@test.com')
  git('config', 'user.name', 'Test')
  await mkdir(join(repo, 'host'), { recursive: true })
  await writeFile(join(repo, 'host', 'server.mjs'), 'landed\n')
  git('add', '.')
  git('commit', '-m', 'init')
  // Another session's work in progress in the shared checkout.
  await writeFile(join(repo, 'host', 'server.mjs'), 'uncommitted\n')
  await writeFile(join(repo, 'host', 'draft.mjs'), 'untracked\n')
  await mkdir(join(repo, 'node_modules'), { recursive: true })
  const destination = join(parent, 'checkout')

  await exportCommit({ repoRoot: repo, commit: await readMainCommit({ repoRoot: repo }), destination })

  assert.equal(await readFile(join(destination, 'host', 'server.mjs'), 'utf8'), 'landed\n')
  assert.equal(await pathExists(join(destination, 'host', 'draft.mjs')), false)
  assert.equal(await pathExists(join(destination, 'node_modules')), true)
})

test('a running or unreadable chat job journal holds an update', async (context) => {
  const directory = await makeTempDir('ensync-chat-jobs-')
  context.after(() => rm(directory, { recursive: true, force: true }))
  const journalPath = join(directory, 'ensync-host-jobs-v1.json')

  await writeFile(journalPath, JSON.stringify({ payload: { jobs: [{ state: 'completed' }, { state: 'running' }] } }))
  assert.equal(await hasRunningChatJobs({ journalPath }), true)
  await writeFile(journalPath, JSON.stringify({ payload: { jobs: [{ state: 'completed' }, { state: 'failed' }, { state: 'cancelled' }] } }))
  assert.equal(await hasRunningChatJobs({ journalPath }), false)

  await writeFile(journalPath, '{not-json')
  assert.equal(await hasRunningChatJobs({ journalPath }), true)
  assert.equal(await hasRunningChatJobs({ journalPath: join(directory, 'missing.json') }), false)
})

test('a connected phone broker keeps the Host busy, read through a lease that is released at once', async (context) => {
  const directory = await makeTempDir('ensync-broker-')
  context.after(() => rm(directory, { recursive: true, force: true }))
  const descriptorPath = join(directory, 'ensync-host-daemon-v1.json')
  await writeFile(descriptorPath, JSON.stringify({ pid: 4242, port: 55925, token: 'a'.repeat(64), instanceId: 'host-1' }))

  const calls = []
  const host = (running, statusCode = 200, body = { running }) => async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push({ path, owner: init.headers?.['x-ensync-owner'] ?? JSON.parse(init.body ?? '{}').ownerId })
    if (path === '/api/remote/broker/status') return new Response(JSON.stringify(body), { status: statusCode })
    return new Response(JSON.stringify({ lease: {} }), { status: 200 })
  }

  assert.equal(await brokerKeepsHostBusy({ descriptorPath, fetchImpl: host(true) }), true)
  assert.deepEqual(calls.map((call) => call.path), ['/api/daemon/claim', '/api/remote/broker/status', '/api/daemon/release'])
  assert.equal(new Set(calls.map((call) => call.owner)).size, 1)
  assert.match(calls[0].owner, /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/)

  calls.length = 0
  assert.equal(await brokerKeepsHostBusy({ descriptorPath, fetchImpl: host(false) }), false)
  assert.equal(calls.at(-1).path, '/api/daemon/release')

  // A Host that predates the broker has no status route and nothing to wait for.
  assert.equal(await brokerKeepsHostBusy({ descriptorPath, fetchImpl: host(true, 404) }), false)
  // Signed out, the Host refuses the status read, and no broker can be running.
  // Captured from the installed Host on 2026-09-14.
  const signedOut = { error: 'Sign in to use remote execution.', code: 'sync_login_required' }
  assert.equal(await brokerKeepsHostBusy({ descriptorPath, fetchImpl: host(true, 401, signedOut) }), false)
  // Any other refusal cannot prove the broker is idle, so the update keeps waiting.
  assert.equal(await brokerKeepsHostBusy({ descriptorPath, fetchImpl: host(true, 500, { error: 'boom' }) }), true)
  // A Host that is not answering is not busy.
  assert.equal(await brokerKeepsHostBusy({ descriptorPath, fetchImpl: async () => { throw new Error('ECONNREFUSED') } }), false)
  assert.equal(await brokerKeepsHostBusy({ descriptorPath: join(directory, 'missing.json') }), false)
})

test('waiting for the old Host reports whether it actually exited', async () => {
  let polls = 0
  assert.equal(await waitForProcessExit(1, { timeoutMs: 1_000, intervalMs: 1, isAlive: () => (polls += 1) < 3 }), true)
  assert.equal(await waitForProcessExit(1, { timeoutMs: 20, intervalMs: 5, isAlive: () => true }), false)
})

const INSTALLED_COMMIT = 'a'.repeat(40)
const NEW_COMMIT = 'b'.repeat(40)

function fakeUpdater(overrides = {}) {
  const calls = []
  const state = { lastSeen: INSTALLED_COMMIT }
  const record = (name, value) => async (...args) => {
    calls.push([name, ...args])
    return typeof value === 'function' ? value(...args) : value
  }
  const deps = {
    appBundle: '/Applications/Ensync.app',
    exportDirectory: '/tmp/ensync-export',
    hostRetireTimeoutMs: 30_000,
    log: () => {},
    logDeferral: (_commit, reason) => calls.push(['deferred', reason]),
    pathExists: async () => true,
    readMainCommit: async () => NEW_COMMIT,
    loadLastSeenCommit: async () => state.lastSeen,
    saveLastSeenCommit: async (commit) => { calls.push(['saveLastSeenCommit', commit]); state.lastSeen = commit },
    hasActiveLanding: async () => false,
    hasRunningChatJobs: async () => false,
    brokerKeepsHostBusy: async () => false,
    exportCommit: record('exportCommit', ({ destination }) => destination),
    buildUi: record('buildUi'),
    removeExport: record('removeExport'),
    performIncrementalUpdate: record('performIncrementalUpdate', { changed: ['host/chat.mjs', 'ui/index.html'], total: 2, relaunched: false, deferred: false }),
    isAppShellRunning: async () => true,
    readHostDescriptor: async () => ({ pid: 4242 }),
    waitForProcessExit: record('waitForProcessExit', true),
    killApp: record('killApp'),
    launchApp: record('launchApp', true),
    ...overrides,
  }
  return { deps, calls, state }
}

test('a new main commit installs from its export and reopens Ensync only after the old Host retires', async () => {
  const { deps, calls, state } = fakeUpdater()

  const result = await runContinuousUpdateCheck(deps)

  assert.deepEqual(result, { outcome: 'installed', relaunched: true, hostRetired: true })
  assert.deepEqual(calls.map(([name]) => name), [
    'exportCommit', 'buildUi', 'performIncrementalUpdate', 'removeExport',
    'killApp', 'waitForProcessExit', 'launchApp', 'saveLastSeenCommit',
  ])
  assert.deepEqual(calls.find(([name]) => name === 'exportCommit')[1], { commit: NEW_COMMIT, destination: '/tmp/ensync-export' })
  assert.deepEqual(calls.find(([name]) => name === 'buildUi')[1], { repoRoot: '/tmp/ensync-export' })
  const update = calls.find(([name]) => name === 'performIncrementalUpdate')[1]
  assert.equal(update.hostSrc, '/tmp/ensync-export/host')
  assert.equal(update.distSrc, '/tmp/ensync-export/dist')
  assert.equal(update.buildUi, false)
  assert.equal(update.killAndRelaunch, false)
  assert.equal(calls.find(([name]) => name === 'waitForProcessExit')[1], 4242)
  assert.equal(state.lastSeen, NEW_COMMIT)
})

test('a new main commit waits, moving nothing, while the Host is busy', async () => {
  for (const busy of [
    { hasActiveLanding: async () => true },
    { hasRunningChatJobs: async () => true },
    { brokerKeepsHostBusy: async () => true },
  ]) {
    const { deps, calls, state } = fakeUpdater(busy)
    assert.equal((await runContinuousUpdateCheck(deps)).outcome, 'deferred')
    assert.deepEqual(calls.map(([name]) => name), ['deferred'])
    assert.equal(state.lastSeen, INSTALLED_COMMIT)
  }
})

test('work that starts during the build holds the install before any file moves', async () => {
  let checks = 0
  const { deps, calls, state } = fakeUpdater({ hasRunningChatJobs: async () => (checks += 1) > 1 })

  assert.equal((await runContinuousUpdateCheck(deps)).outcome, 'deferred')
  assert.deepEqual(calls.map(([name]) => name), ['exportCommit', 'buildUi', 'deferred', 'removeExport'])
  assert.equal(state.lastSeen, INSTALLED_COMMIT)
})

test('an install that changes no file records the commit without closing Ensync', async () => {
  const { deps, calls, state } = fakeUpdater({
    performIncrementalUpdate: async () => ({ changed: [], total: 0, relaunched: false, deferred: false }),
  })

  assert.equal((await runContinuousUpdateCheck(deps)).outcome, 'unchanged')
  assert.equal(calls.some(([name]) => ['killApp', 'launchApp'].includes(name)), false)
  assert.equal(state.lastSeen, NEW_COMMIT)
})

test('a UI-only install reopens Ensync without waiting on the Host', async () => {
  const { deps, calls } = fakeUpdater({
    performIncrementalUpdate: async () => ({ changed: ['ui/index.html'], total: 1, relaunched: false, deferred: false }),
  })

  assert.deepEqual(await runContinuousUpdateCheck(deps), { outcome: 'installed', relaunched: true, hostRetired: null })
  assert.equal(calls.some(([name]) => name === 'waitForProcessExit'), false)
})

test('an install while Ensync is closed never opens it', async () => {
  const { deps, calls } = fakeUpdater({ isAppShellRunning: async () => false })

  assert.deepEqual(await runContinuousUpdateCheck(deps), { outcome: 'installed', relaunched: false })
  assert.equal(calls.some(([name]) => ['killApp', 'waitForProcessExit', 'launchApp'].includes(name)), false)
})

test('an already installed commit does nothing', async () => {
  const { deps, calls } = fakeUpdater({ readMainCommit: async () => INSTALLED_COMMIT })

  assert.equal((await runContinuousUpdateCheck(deps)).outcome, 'current')
  assert.deepEqual(calls, [])
})

test('readMainCommit returns a 40-char hex string for a real git repo', async (context) => {
  const repo = await makeTempDir('ensync-git-repo-')
  context.after(() => rm(repo, { recursive: true }))

  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  await exec('git', ['init', '-b', 'main'], { cwd: repo })
  await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), '# test')
  await exec('git', ['add', '.'], { cwd: repo })
  await exec('git', ['commit', '-m', 'init'], { cwd: repo })

  const commit = await readMainCommit({ repoRoot: repo })
  assert.equal(typeof commit, 'string')
  assert.equal(commit.length, 40)
  assert.match(commit, /^[a-f0-9]{40}$/)
})

test('readMainCommit returns null when main does not exist', async (context) => {
  const repo = await makeTempDir('ensync-empty-repo-')
  context.after(() => rm(repo, { recursive: true })
    .catch(() => {}))
  const commit = await readMainCommit({ repoRoot: repo })
  assert.equal(commit, null)
})

test('continuous updates defer only queued or integrating landing work', async (context) => {
  const directory = await makeTempDir('ensync-active-landing-')
  context.after(() => rm(directory, { recursive: true, force: true }))
  const journalPath = join(directory, 'landing-journal.json')

  for (const state of ['queued', 'integrating']) {
    await writeFile(journalPath, JSON.stringify({ payload: { items: [{ state }] } }))
    assert.equal(await hasActiveLanding({ journalPath }), true, state)
  }
  for (const state of ['retry', 'held', 'landed']) {
    await writeFile(journalPath, JSON.stringify({ payload: { items: [{ state }] } }))
    assert.equal(await hasActiveLanding({ journalPath }), false, state)
  }
})

test('continuous updates fail closed for an existing unreadable landing journal', async (context) => {
  const directory = await makeTempDir('ensync-invalid-landing-')
  context.after(() => rm(directory, { recursive: true, force: true }))
  const journalPath = join(directory, 'landing-journal.json')
  await writeFile(journalPath, '{not-json')

  assert.equal(await hasActiveLanding({ journalPath }), true)
  assert.equal(await hasActiveLanding({ journalPath: join(directory, 'missing.json') }), false)
})

test('the shared app updater refuses bundle mutation while landing is active', async (context) => {
  const directory = await makeTempDir('ensync-guarded-bundle-update-')
  context.after(() => rm(directory, { recursive: true, force: true }))
  const appBundle = join(directory, 'Ensync.app')
  const hostSrc = join(directory, 'host-src')
  const hostDest = join(appBundle, 'Contents', 'Resources', 'host')
  const journalPath = join(directory, 'landing-journal.json')
  await mkdir(appBundle, { recursive: true })
  await mkdir(hostSrc, { recursive: true })
  await writeFile(join(hostSrc, 'server.mjs'), 'new host bytes\n')
  await writeFile(journalPath, JSON.stringify({ payload: { items: [{ state: 'integrating' }] } }))

  const result = await performIncrementalUpdate({
    appBundle,
    hostSrc,
    hostDest,
    rebuildUi: false,
    killAndRelaunch: false,
    landingJournalPath: journalPath,
  })

  assert.deepEqual(result, { changed: [], total: 0, relaunched: false, deferred: true })
  assert.equal(await pathExists(join(hostDest, 'server.mjs')), false)
})

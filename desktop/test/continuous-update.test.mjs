import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appShellProcessPattern,
  copyIfChanged,
  hasActiveLanding,
  hashFile,
  pathExists,
  performIncrementalUpdate,
  readMainCommit,
  updateHostFiles,
  updateUiFiles,
} from '../scripts/app-bundle-update.mjs'

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

test('updateUiFiles copies index.html and assets, wiping stale assets first', async (context) => {
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

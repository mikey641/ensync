import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  createLocalFileOpenHandler,
  LOCAL_FILE_OPEN_CHANNEL,
} from '../src/local-file-open.mjs'

function createHandler(overrides = {}) {
  const calls = { opened: [], revealed: [] }
  const handler = createLocalFileOpenHandler({
    isAuthorized: () => true,
    describePath: () => ({ exists: true, directory: false }),
    openPath: (path) => {
      calls.opened.push(path)
      return ''
    },
    revealPath: (path) => {
      calls.revealed.push(path)
    },
    ...overrides,
  })
  return { handler, calls }
}

test('local file open refuses renderers that are not an Ensync workspace window', async () => {
  const { handler, calls } = createHandler({ isAuthorized: () => false })

  assert.deepEqual(await handler({}, '/Users/me/notes.md'), {
    status: 'error',
    message: 'Opening a local file is available only to the Ensync app window.',
  })
  assert.deepEqual(calls, { opened: [], revealed: [] })
})

test('local file open refuses anything that is not an absolute path', async () => {
  const { handler, calls } = createHandler()

  for (const request of ['docs/design.md', '', null, 42, 'https://ensync.app']) {
    assert.equal((await handler({}, request)).status, 'error')
  }
  assert.deepEqual(calls, { opened: [], revealed: [] })
})

test('local file open reports a target that is no longer on disk', async () => {
  const { handler, calls } = createHandler({ describePath: () => ({ exists: false, directory: false }) })

  assert.deepEqual(await handler({}, '/Users/me/gone.md'), {
    status: 'missing',
    message: 'That file is no longer at /Users/me/gone.md.',
  })
  assert.deepEqual(calls, { opened: [], revealed: [] })
})

test('local file open hands an ordinary document and a folder to the system opener', async () => {
  const { handler, calls } = createHandler({
    describePath: (path) => ({ exists: true, directory: path.endsWith('docs') }),
  })

  assert.deepEqual(await handler({}, '/Users/me/docs/design.md'), { status: 'opened' })
  assert.deepEqual(await handler({}, '/Users/me/docs'), { status: 'opened' })
  assert.deepEqual(calls.opened, ['/Users/me/docs/design.md', '/Users/me/docs'])
  assert.deepEqual(calls.revealed, [])
})

test('local file open reveals executable targets instead of running them', async () => {
  const { handler, calls } = createHandler()

  for (const path of [
    '/Applications/Calculator.app',
    '/Users/me/setup.command',
    '/Users/me/setup.SH',
    '/Users/me/tool.exe',
    '/Users/me/install.msi',
    '/Users/me/run.bat',
    '/Users/me/run.ps1',
  ]) {
    assert.deepEqual(await handler({}, path), {
      status: 'revealed',
      message: 'Ensync showed that item in the file manager instead of running it.',
    })
  }
  assert.deepEqual(calls.opened, [])
  assert.equal(calls.revealed.length, 7)
})

test('local file open reveals the target when the system opener refuses it', async () => {
  const { handler, calls } = createHandler({ openPath: () => 'no application knows how to open this' })

  assert.equal((await handler({}, '/Users/me/notes.unknown')).status, 'revealed')
  assert.deepEqual(calls.revealed, ['/Users/me/notes.unknown'])
})

test('local file open is wired through the packaged native bridge', async () => {
  const desktopRoot = resolve(import.meta.dirname, '..')
  const [main, preload, manifest] = await Promise.all([
    readFile(resolve(desktopRoot, 'src/main.mjs'), 'utf8'),
    readFile(resolve(desktopRoot, 'src/preload.cjs'), 'utf8'),
    readFile(resolve(desktopRoot, 'package.json'), 'utf8').then(JSON.parse),
  ])

  assert.equal(LOCAL_FILE_OPEN_CHANNEL, 'ensync:shell:open-local-file')
  assert.match(main, /ipcMain\.handle\(LOCAL_FILE_OPEN_CHANNEL, createLocalFileOpenHandler\(\{/)
  assert.match(main, /ipcMain\.removeHandler\(LOCAL_FILE_OPEN_CHANNEL\)/)
  assert.match(preload, /openLocalFile: \(path\) => ipcRenderer\.invoke\(LOCAL_FILE_OPEN_CHANNEL, path\)/)
  assert.ok(manifest.build.files.includes('src/local-file-open.mjs'))
})

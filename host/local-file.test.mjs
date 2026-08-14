import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAX_DISPLAY_BYTES, readLocalFileForDisplay } from './local-file.mjs'
import { createEnsyncHost } from './server.mjs'

async function workspace(context) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-local-file-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('local file display returns the exact text, name, and language of a readable file', async (context) => {
  const root = await workspace(context)
  const path = join(root, 'design notes.md')
  await writeFile(path, '# Title\n\nשלום world\n', 'utf8')

  assert.deepEqual(await readLocalFileForDisplay(path), {
    status: 'ok',
    path,
    name: 'design notes.md',
    text: '# Title\n\nשלום world\n',
    bytes: Buffer.byteLength('# Title\n\nשלום world\n'),
    truncated: false,
    language: 'md',
  })
})

test('local file display truncates a very large file instead of refusing it', async (context) => {
  const root = await workspace(context)
  const path = join(root, 'huge.log')
  const line = `${'x'.repeat(63)}\n`
  await writeFile(path, line.repeat(Math.ceil((MAX_DISPLAY_BYTES * 2) / line.length)), 'utf8')

  const result = await readLocalFileForDisplay(path)
  assert.equal(result.status, 'ok')
  assert.equal(result.truncated, true)
  assert.equal(Buffer.byteLength(result.text), MAX_DISPLAY_BYTES)
  assert.ok(result.bytes > MAX_DISPLAY_BYTES)
})

test('local file display refuses binary content rather than rendering control bytes', async (context) => {
  const root = await workspace(context)
  const path = join(root, 'icon.png')
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]))

  const result = await readLocalFileForDisplay(path)
  assert.equal(result.status, 'binary')
  assert.equal(result.name, 'icon.png')
  assert.equal(result.text, undefined)
})

test('local file display reports a missing file, a folder, and a non-absolute request', async (context) => {
  const root = await workspace(context)
  await mkdir(join(root, 'docs'))

  assert.equal((await readLocalFileForDisplay(join(root, 'gone.md'))).status, 'missing')
  assert.equal((await readLocalFileForDisplay(join(root, 'docs'))).status, 'directory')
  assert.equal((await readLocalFileForDisplay('docs/design.md')).status, 'invalid')
  assert.equal((await readLocalFileForDisplay('')).status, 'invalid')
  assert.equal((await readLocalFileForDisplay(null)).status, 'invalid')

  for (const status of ['missing', 'directory', 'invalid']) {
    const result = status === 'missing'
      ? await readLocalFileForDisplay(join(root, 'gone.md'))
      : status === 'directory'
        ? await readLocalFileForDisplay(join(root, 'docs'))
        : await readLocalFileForDisplay('docs/design.md')
    assert.equal(typeof result.message, 'string')
    assert.ok(result.message.length > 0)
  }
})

test('host serves the file display over the local API', async (context) => {
  const root = await workspace(context)
  const path = join(root, 'spec.md')
  await writeFile(path, 'display me\n', 'utf8')

  const server = createEnsyncHost()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const ok = await fetch(`${baseUrl}/api/local-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).then((response) => response.json())
  assert.equal(ok.file.status, 'ok')
  assert.equal(ok.file.text, 'display me\n')
  assert.equal(ok.file.name, 'spec.md')

  const missing = await fetch(`${baseUrl}/api/local-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: join(root, 'nope.md') }),
  }).then((response) => response.json())
  assert.equal(missing.file.status, 'missing')
})

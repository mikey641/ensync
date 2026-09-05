import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import test from 'node:test'

import { ChatAttachmentStore, probeAttachmentPaths } from './chat-attachments.mjs'
import { ChatRunError, validateAttachmentPaths } from './chat.mjs'
import { createEnsyncHost } from './server.mjs'

async function fixtureDir(context) {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-attachments-test-'))
  context.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function unopenableFixture(context, dir, name) {
  const path = join(dir, name)
  await writeFile(path, 'bytes the agent may never open')
  await chmod(path, 0o000)
  context.after(() => chmod(path, 0o600).catch(() => {}))
  return path
}

test('the probe reports which paths an unentitled process can actually open', async (context) => {
  const dir = await fixtureDir(context)
  const readablePath = join(dir, 'readable.png')
  await writeFile(readablePath, 'image fixture')
  const protectedPath = await unopenableFixture(context, dir, 'protected.png')
  const missingPath = join(dir, 'missing.png')

  assert.deepEqual(await probeAttachmentPaths([readablePath, protectedPath, missingPath]), {
    results: [
      { path: readablePath, readable: true },
      { path: protectedPath, readable: false },
      { path: missingPath, readable: false },
    ],
  })
})

test('the probe rejects relative paths and oversized batches before touching the disk', async () => {
  await assert.rejects(
    probeAttachmentPaths(['relative.png']),
    (error) => error instanceof ChatRunError && error.code === 'invalid_attachment',
  )
  await assert.rejects(
    probeAttachmentPaths(Array.from({ length: 65 }, (_, index) => `/tmp/file-${index}.png`)),
    (error) => error instanceof ChatRunError && error.code === 'invalid_attachments' && error.status === 413,
  )
})

test('the store copies attachment bytes under its root and keeps the display extension', async (context) => {
  const root = join(await fixtureDir(context), 'chat-attachments-v1')
  const store = new ChatAttachmentStore({ rootPath: root })
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])

  const stored = await store.store({ name: '../“Screenshot” 2026-08-09 at 17:30.47.PNG', bytes })
  assert.ok(stored.path.startsWith(`${root}${sep}`))
  assert.ok(!relative(root, stored.path).split(sep).includes('..'))
  assert.ok(stored.path.endsWith('.PNG'))
  assert.deepEqual(await readFile(stored.path), bytes)

  const second = await store.store({ name: '../“Screenshot” 2026-08-09 at 17:30.47.PNG', bytes })
  assert.notEqual(second.path, stored.path)
})

test('the store refuses oversized, empty, or nameless uploads with honest errors', async (context) => {
  const root = join(await fixtureDir(context), 'chat-attachments-v1')
  const store = new ChatAttachmentStore({ rootPath: root, maxBytes: 8 })

  await assert.rejects(
    store.store({ name: 'big.bin', bytes: Buffer.alloc(9) }),
    (error) => error instanceof ChatRunError && error.code === 'invalid_attachment' && error.status === 413,
  )
  await assert.rejects(
    store.store({ name: 'empty.png', bytes: Buffer.alloc(0) }),
    (error) => error instanceof ChatRunError && error.code === 'invalid_attachment',
  )
  await assert.rejects(
    store.store({ name: '...', bytes: Buffer.from('x') }),
    (error) => error instanceof ChatRunError && error.code === 'invalid_attachment',
  )
  await assert.rejects(
    store.store({ name: 'no-bytes.png', bytes: 'not binary' }),
    (error) => error instanceof ChatRunError && error.code === 'invalid_attachment',
  )
})

async function listeningHost(context, options) {
  const server = createEnsyncHost(options)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

test('the host serves attachment probe and store endpoints for the renderer', async (context) => {
  const dir = await fixtureDir(context)
  const readablePath = join(dir, 'readable.txt')
  await writeFile(readablePath, 'ok')
  const protectedPath = await unopenableFixture(context, dir, 'protected.png')
  const storeRoot = join(dir, 'store-root')
  const base = await listeningHost(context, { chatAttachmentsRoot: storeRoot })

  const probeResponse = await fetch(`${base}/api/chat/attachments/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [readablePath, protectedPath] }),
  })
  assert.equal(probeResponse.status, 200)
  assert.deepEqual(await probeResponse.json(), {
    results: [
      { path: readablePath, readable: true },
      { path: protectedPath, readable: false },
    ],
  })

  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])
  const storeResponse = await fetch(
    `${base}/api/chat/attachments?name=${encodeURIComponent('Screenshot 2026-08-09 at 17.30.47.png')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes },
  )
  assert.equal(storeResponse.status, 201)
  const { attachment } = await storeResponse.json()
  assert.equal(attachment.name, 'Screenshot 2026-08-09 at 17.30.47.png')
  assert.ok(attachment.path.startsWith(`${storeRoot}${sep}`))
  assert.deepEqual(await readFile(attachment.path), bytes)
  assert.deepEqual(await validateAttachmentPaths([attachment.path]), [await realpath(attachment.path)])
})

test('the store endpoint reports upload-size violations instead of crashing the host', async (context) => {
  const dir = await fixtureDir(context)
  const base = await listeningHost(context, {
    chatAttachmentStore: new ChatAttachmentStore({ rootPath: join(dir, 'store-root'), maxBytes: 8 }),
  })

  const storeResponse = await fetch(`${base}/api/chat/attachments?name=big.bin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(9),
  })
  assert.equal(storeResponse.status, 413)
  const payload = await storeResponse.json()
  assert.equal(payload.code, 'invalid_attachment')
})

test('send-time validation opens each attachment so protected paths fail with re-attach guidance', async (context) => {
  const dir = await fixtureDir(context)
  const protectedPath = await unopenableFixture(context, dir, 'screenshot.png')

  await assert.rejects(
    validateAttachmentPaths([protectedPath]),
    (error) => error instanceof ChatRunError
      && error.code === 'unreadable_attachment'
      && error.message.includes('screenshot.png')
      && /re-attach/i.test(error.message),
  )
})

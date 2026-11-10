import assert from 'node:assert/strict'
import test from 'node:test'
import { pastedAttachmentName, resolvePastedAttachments } from './fileAttachments.mjs'

const now = new Date('2026-11-10T18:04:05.000Z')
const fakeFile = (name, type, text = 'x') => ({ name, type, arrayBuffer: async () => new TextEncoder().encode(text).buffer })

test('a generic clipboard image gets a unique timestamped name; a real filename is kept', () => {
  assert.equal(pastedAttachmentName(fakeFile('image.png', 'image/png'), now), 'pasted-20261110-180405.png')
  assert.equal(pastedAttachmentName(fakeFile('', 'image/jpeg'), now, 1), 'pasted-20261110-180405-2.jpg')
  assert.equal(pastedAttachmentName(fakeFile('receipt.pdf', 'application/pdf'), now), 'receipt.pdf')
})

test('pasted image data is stored through the host; a Finder file with a path is attached by path', async () => {
  const stored = []
  const result = await resolvePastedAttachments(
    [fakeFile('image.png', 'image/png'), fakeFile('notes.txt', 'text/plain')],
    (file) => (file.name === 'notes.txt' ? '/Users/me/notes.txt' : ''),
    {
      probeAttachmentPaths: async (paths) => ({ results: paths.map((path) => ({ path, readable: true })) }),
      storeChatAttachment: async (name) => { stored.push(name); return { attachment: { name, path: `/tmp/att/${name}` } } },
    },
    now,
  )
  assert.deepEqual(stored, ['pasted-20261110-180405.png'])
  assert.deepEqual(result.unavailable, [])
  assert.deepEqual(result.attachments.map((a) => a.path).sort(), ['/Users/me/notes.txt', '/tmp/att/pasted-20261110-180405.png'])
})

test('a paste the host cannot store is reported, not dropped silently', async () => {
  const result = await resolvePastedAttachments([fakeFile('image.png', 'image/png')], null, {
    probeAttachmentPaths: async () => ({ results: [] }),
    storeChatAttachment: async () => { throw new Error('offline') },
  }, now)
  assert.deepEqual(result.attachments, [])
  assert.deepEqual(result.unavailable, ['pasted-20261110-180405.png'])
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  appendFileAttachments,
  fileDragContainsFiles,
  messageTextWithAttachments,
  normalizeFileAttachments,
  resolveDroppedAttachments,
  visibleMessageText,
} from '../src/lib/fileAttachments.mjs'

function fakeFile(name, nativePath, bytes = Uint8Array.from([1, 2, 3])) {
  return {
    name,
    nativePath,
    arrayBuffer: async () => bytes.buffer,
  }
}

function recordingHostOps({ unreadable = [], storedPath = '/stored/copy.png', failStore = false, failProbe = false } = {}) {
  const calls = { probes: [], stores: [] }
  return {
    calls,
    probeAttachmentPaths: async (paths) => {
      calls.probes.push(paths)
      if (failProbe) throw new Error('host offline')
      return { results: paths.map((path) => ({ path, readable: !unreadable.includes(path) })) }
    },
    storeChatAttachment: async (name, bytes) => {
      calls.stores.push({ name, byteLength: bytes.byteLength })
      if (failStore) throw new Error('store failed')
      return { attachment: { path: storedPath, name } }
    },
  }
}

test('file drag detection accepts the browser Files type without filtering MIME types', () => {
  assert.equal(fileDragContainsFiles(['text/plain', 'Files']), true)
  assert.equal(fileDragContainsFiles({ types: [], items: [{ kind: 'file' }], files: [] }), true)
  assert.equal(fileDragContainsFiles({ types: [], items: [], files: [{ name: 'fallback.txt' }] }), true)
  assert.equal(fileDragContainsFiles(['text/plain']), false)
})

test('dropped files resolve through the native bridge and retain every file type', async () => {
  const files = [
    { name: 'reference.png', nativePath: '/tmp/reference.png' },
    { name: 'archive.weird', nativePath: '/tmp/archive.weird' },
  ]
  assert.deepEqual(await resolveDroppedAttachments(files, (file) => file.nativePath, recordingHostOps()), {
    attachments: [
      { name: 'reference.png', path: '/tmp/reference.png' },
      { name: 'archive.weird', path: '/tmp/archive.weird' },
    ],
    unavailable: [],
  })
})

test('attachment helpers deduplicate persisted paths and create an explicit provider prompt', () => {
  const first = { name: 'one.png', path: '/tmp/one.png' }
  const second = { name: 'two.pdf', path: '/tmp/two.pdf' }
  assert.deepEqual(normalizeFileAttachments([first, { ...first }, null]), [first])
  assert.deepEqual(appendFileAttachments([first], [first, second]), [first, second])
  assert.equal(visibleMessageText('', [first]), 'Attached 1 file.')
  assert.equal(visibleMessageText('', [first, second]), 'Attached 2 files.')
  assert.equal(messageTextWithAttachments('Review these', [first, second]), [
    'Review these',
    '',
    '[Explicitly attached local files]',
    '- "/tmp/one.png"',
    '- "/tmp/two.pdf"',
    'The user explicitly attached these files to this turn. Inspect them as needed for the request.',
  ].join('\n'))
})

test('browser drops fail honestly when no native path bridge exists', async () => {
  const result = await resolveDroppedAttachments([{ name: 'photo.jpg' }], null, null)
  assert.deepEqual(result, { attachments: [], unavailable: ['photo.jpg'] })
})

test('host-readable dropped files stay attached by their original path', async () => {
  const hostOps = recordingHostOps()
  const result = await resolveDroppedAttachments(
    [fakeFile('notes.md', '/home/user/notes.md')],
    (file) => file.nativePath,
    hostOps,
  )
  assert.deepEqual(result, {
    attachments: [{ name: 'notes.md', path: '/home/user/notes.md' }],
    unavailable: [],
  })
  assert.deepEqual(hostOps.calls.probes, [['/home/user/notes.md']])
  assert.equal(hostOps.calls.stores.length, 0)
})

test('files the host cannot open are copied through the host and re-pathed', async () => {
  const protectedPath = '/T/TemporaryItems/NSIRD_screencaptureui_x/Screenshot.png'
  const hostOps = recordingHostOps({ unreadable: [protectedPath], storedPath: '/state/chat-attachments-v1/id/Screenshot.png' })
  const result = await resolveDroppedAttachments(
    [fakeFile('Screenshot.png', protectedPath, Uint8Array.from([9, 9, 9, 9]))],
    (file) => file.nativePath,
    hostOps,
  )
  assert.deepEqual(result, {
    attachments: [{ name: 'Screenshot.png', path: '/state/chat-attachments-v1/id/Screenshot.png' }],
    unavailable: [],
  })
  assert.deepEqual(hostOps.calls.stores, [{ name: 'Screenshot.png', byteLength: 4 }])
})

test('an unreachable host degrades to by-reference attachment instead of dropping files', async () => {
  const result = await resolveDroppedAttachments(
    [fakeFile('photo.jpg', '/tmp/photo.jpg')],
    (file) => file.nativePath,
    recordingHostOps({ failProbe: true }),
  )
  assert.deepEqual(result, {
    attachments: [{ name: 'photo.jpg', path: '/tmp/photo.jpg' }],
    unavailable: [],
  })
})

test('a failed protected-file copy is reported as unavailable, not silently attached', async () => {
  const protectedPath = '/T/TemporaryItems/NSIRD_screencaptureui_x/Screenshot.png'
  const result = await resolveDroppedAttachments(
    [fakeFile('Screenshot.png', protectedPath), fakeFile('readable.txt', '/tmp/readable.txt')],
    (file) => file.nativePath,
    recordingHostOps({ unreadable: [protectedPath], failStore: true }),
  )
  assert.deepEqual(result, {
    attachments: [{ name: 'readable.txt', path: '/tmp/readable.txt' }],
    unavailable: ['Screenshot.png'],
  })
})

test('resolution without the native bridge reports every file as unavailable', async () => {
  const result = await resolveDroppedAttachments([{ name: 'photo.jpg' }], null, recordingHostOps())
  assert.deepEqual(result, { attachments: [], unavailable: ['photo.jpg'] })
})

function appDropHandler(source) {
  const start = source.indexOf('const handleFilesDrop')
  assert.notEqual(start, -1, 'src/App.tsx no longer declares handleFilesDrop')
  const end = source.indexOf('\n  const ', start + 1)
  return source.slice(start, end === -1 ? source.length : end)
}

// The copy-through-host helper only protects anyone if the app calls it. A
// merge once dropped this call site while keeping the import, an unused-import
// sweep then removed the leftover import, and OS-protected screenshot drops
// silently went back to failing at send time with nothing left to recover
// from. The helper's own tests could not see that, so assert the wiring here.
test('the composer drop handler copies protected files through the host at drop time', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const handler = appDropHandler(app)
  assert.match(handler, /await resolveDroppedAttachments\(/)
  assert.match(handler, /probeAttachmentPaths/)
  assert.match(handler, /storeChatAttachment/)
  // Attaching by raw path alone is the regression, so no by-reference-only
  // drop helper may come back as the app's drop path.
  assert.doesNotMatch(app, /\bdroppedFileAttachments\(/)
})

// A dropped file is readable only through the File objects handed to this
// event; the DataTransfer list itself empties as soon as the handler yields.
test('the composer drop handler snapshots the dropped files before it yields', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const handler = appDropHandler(app)
  const snapshot = handler.indexOf('Array.from(files)')
  assert.notEqual(snapshot, -1, 'the dropped FileList must be copied into an array')
  assert.ok(snapshot < handler.indexOf('await'), 'the FileList must be snapshotted before the first await')
})

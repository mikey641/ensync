import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendFileAttachments,
  droppedFileAttachments,
  fileDragContainsFiles,
  messageTextWithAttachments,
  normalizeFileAttachments,
  visibleMessageText,
} from '../src/lib/fileAttachments.mjs'

test('file drag detection accepts the browser Files type without filtering MIME types', () => {
  assert.equal(fileDragContainsFiles(['text/plain', 'Files']), true)
  assert.equal(fileDragContainsFiles(['text/plain']), false)
})

test('dropped files resolve through the native bridge and retain every file type', () => {
  const files = [
    { name: 'reference.png', nativePath: '/tmp/reference.png' },
    { name: 'archive.weird', nativePath: '/tmp/archive.weird' },
  ]
  assert.deepEqual(droppedFileAttachments(files, (file) => file.nativePath), {
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

test('browser drops fail honestly when no native path bridge exists', () => {
  const result = droppedFileAttachments([{ name: 'photo.jpg' }], null)
  assert.deepEqual(result, { attachments: [], unavailable: ['photo.jpg'] })
})

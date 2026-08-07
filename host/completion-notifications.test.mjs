import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const completionNotificationsPath = new URL('../src/completion-notifications.tsx', import.meta.url)

test('turning finished-task speech off cancels queued and active announcements', async () => {
  const source = await readFile(completionNotificationsPath, 'utf8')

  assert.match(source, /export function stopCompletionSpeech\(\)/)
  assert.match(source, /window\.speechSynthesis\.cancel\(\)/)
  assert.equal(source.match(/if \(next\.mode !== 'speech'\) stopCompletionSpeech\(\)/g)?.length, 3)
  assert.match(source, /mode: 'off'/)
})

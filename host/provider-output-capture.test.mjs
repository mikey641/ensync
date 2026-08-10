import assert from 'node:assert/strict'
import test from 'node:test'

import { BoundedOutputCapture, runProcess } from './command.mjs'
import {
  ChatRunError,
  parseClaudeChatResult,
  parseCodexChatResult,
  quotaFailureIsSafe,
} from './chat.mjs'

const CLAUDE_SESSION_ID = '11111111-1111-4111-8111-111111111111'
const CODEX_THREAD_ID = '123e4567-e89b-12d3-a456-426614174000'

function claudeStreamScript({ toolEventCount, toolEventCharacters }) {
  return [
    `const filler = 'x'.repeat(${toolEventCharacters})`,
    `process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: '${CLAUDE_SESSION_ID}', model: 'claude-opus-5' }) + '\\n')`,
    `for (let index = 0; index < ${toolEventCount}; index += 1) {`,
    "  process.stdout.write(JSON.stringify({ type: 'user', tool_use_result: { originalFile: filler } }) + '\\n')",
    '}',
    `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Combined unit post shipped.', session_id: '${CLAUDE_SESSION_ID}' }) + '\\n')`,
  ].join('\n')
}

function retainedLines(stdout) {
  return stdout.split('\n').filter((line) => line.trim())
}

test('bounded capture drops whole middle lines instead of cutting the stream mid-event', () => {
  const capture = new BoundedOutputCapture(400)
  capture.append(`${'a'.repeat(99)}\n`)
  for (let index = 0; index < 20; index += 1) {
    capture.append(`${String(index).padStart(99, '-')}\n`)
  }
  capture.append(`${'z'.repeat(99)}\n`)

  const lines = capture.text.split('\n').filter(Boolean)
  assert.ok(capture.text.length <= 400)
  assert.equal(lines[0], 'a'.repeat(99), 'the first line stays retained as stream head')
  assert.equal(lines.at(-1), 'z'.repeat(99), 'the newest line stays retained as stream tail')
  assert.ok(lines.every((line) => line.length === 99), 'every retained line is complete')
  assert.ok(capture.truncation.droppedLineCount > 0)
  assert.equal(
    capture.truncation.droppedCharacterCount,
    capture.truncation.droppedLineCount * 100,
  )
})

test('bounded capture reports no truncation for a stream that fits', () => {
  const capture = new BoundedOutputCapture(1_024)
  capture.append('{"type":"result"}\n')
  assert.equal(capture.text, '{"type":"result"}\n')
  assert.equal(capture.truncation, null)
})

test('bounded capture discards a single line larger than the whole budget without poisoning the stream', () => {
  const capture = new BoundedOutputCapture(500)
  capture.append('{"type":"system"}\n')
  capture.append(`${'y'.repeat(4_000)}\n`)
  capture.append('{"type":"result"}\n')

  assert.equal(capture.text, '{"type":"system"}\n{"type":"result"}\n')
  assert.equal(capture.truncation.droppedLineCount, 1)
})

test('an oversized Claude stream still yields its verified terminal result', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', claudeStreamScript({ toolEventCount: 12, toolEventCharacters: 50_000 })],
    { hardTimeoutMs: 30_000, maxCaptureBytes: 200_000 },
  )

  assert.equal(result.exitCode, 0)
  assert.ok(result.stdout.length <= 200_000)
  assert.ok(result.truncation.stdout.droppedLineCount > 0)
  assert.equal(result.truncation.stderr, null)
  for (const line of retainedLines(result.stdout)) JSON.parse(line)

  const parsed = parseClaudeChatResult(result.stdout, {
    outputTruncated: result.truncation.stdout,
  })
  assert.equal(parsed.response, 'Combined unit post shipped.')
  assert.equal(parsed.sessionId, CLAUDE_SESSION_ID)
  assert.deepEqual(parsed.outputTruncation, result.truncation.stdout)
})

test('an oversized Codex stream keeps both its thread identity and terminal completion', async () => {
  const script = [
    "const filler = 'x'.repeat(50000)",
    `process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '${CODEX_THREAD_ID}' }) + '\\n')`,
    'for (let index = 0; index < 12; index += 1) {',
    "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', text: filler } }) + '\\n')",
    '}',
    "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex finished.' } }) + '\\n')",
    "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')",
  ].join('\n')
  const result = await runProcess(process.execPath, ['-e', script], {
    hardTimeoutMs: 30_000,
    maxCaptureBytes: 200_000,
  })

  assert.equal(result.exitCode, 0)
  assert.ok(result.truncation.stdout.droppedLineCount > 0)
  const parsed = parseCodexChatResult(result.stdout, {
    outputTruncated: result.truncation.stdout,
  })
  assert.equal(parsed.response, 'Codex finished.')
  assert.equal(parsed.sessionId, CODEX_THREAD_ID)
})

test('a truncated capture can never prove a quota failure was activity-free', () => {
  const activityFreeQuotaFailure = [
    JSON.stringify({ type: 'thread.started', thread_id: CODEX_THREAD_ID }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'Usage limit reached' } }),
  ].join('\n')

  assert.equal(quotaFailureIsSafe('codex', activityFreeQuotaFailure), true)
  assert.equal(
    quotaFailureIsSafe('codex', activityFreeQuotaFailure, '', { outputTruncated: true }),
    false,
  )
  assert.throws(
    () => parseCodexChatResult(activityFreeQuotaFailure, { outputTruncated: true }),
    (error) => error instanceof ChatRunError
      && error.code === 'cli_failed'
      && error.safeToRetry === false,
  )
})

test('an unverifiable truncated capture names the Host output limit and stays non-retryable', () => {
  assert.throws(
    () => parseClaudeChatResult(JSON.stringify({ type: 'system', subtype: 'init' }), {
      outputTruncated: { droppedLineCount: 4, droppedCharacterCount: 9_000 },
    }),
    (error) => error instanceof ChatRunError
      && error.code === 'invalid_cli_output'
      && error.safeToRetry === false
      && error.message.includes('output limit')
      && !error.message.includes('bounded repair'),
  )
})

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CODEX_CONVERSATION_IMPORT_CONFIRMATION,
  createCodexConversationImportHandler,
  parseCodexConversationImport,
} from '../src/codex-conversation-import.mjs'

const transcriptPath = fileURLToPath(new URL('./fixtures/codex-import-rollout.jsonl', import.meta.url))
const historyPath = fileURLToPath(new URL('./fixtures/codex-import-history.jsonl', import.meta.url))
const projectPath = '/verified/relay'
const dependencies = {
  realpath: () => projectPath,
  pathStat: () => ({ isDirectory: () => true }),
}

test('Codex import keeps only user-visible session text and excludes internal records', () => {
  const candidate = parseCodexConversationImport({
    transcriptPath,
    historyPath,
    projectPath,
    now: () => '2026-08-07T12:00:00.000Z',
  }, dependencies)

  assert.equal(candidate.project.path, projectPath)
  assert.equal(candidate.report.userMessages, 2)
  assert.equal(candidate.report.assistantMessages, 2)
  assert.equal(candidate.report.transcriptIncompleteTailExcluded, false)
  assert.deepEqual(candidate.chat.messages.map((message) => message.role), ['user', 'agent', 'user', 'agent'])
  const visible = candidate.chat.messages.map((message) => message.content).join('\n')
  assert.match(visible, /Visible user request/)
  assert.match(visible, /Visible assistant answer/)
  assert.match(visible, /\[REDACTED\]/)
  assert.doesNotMatch(visible, /supersecretvalue|abcdefghijklmnop|hidden|tool|compaction/i)
  assert.ok(candidate.report.redactionCount >= 2)
  assert.equal(candidate.chat.importSource.messageIds.length, 4)
  assert.match(candidate.id, /^[0-9a-f]{64}$/)
})

test('Codex import IPC requires explicit confirmation and returns only to the exact target workspace', async () => {
  const targetSender = {}
  const otherSender = {}
  let parseCount = 0
  const parsed = parseCodexConversationImport({
    transcriptPath,
    historyPath,
    projectPath,
    now: () => '2026-08-07T12:00:00.000Z',
  }, dependencies)
  const handler = createCodexConversationImportHandler({
    isAuthorized: ({ sender }) => [targetSender, otherSender].includes(sender),
    identityForWebContents: (sender) => ({
      id: sender === targetSender
        ? '97dc48e2-1118-453a-bdb6-40b65e98ba38'
        : '11111111-1111-4111-8111-111111111111',
      kind: 'isolated',
    }),
    transcriptPath,
    historyPath,
    projectPath,
    targetWorkspaceId: '97dc48e2-1118-453a-bdb6-40b65e98ba38',
    confirmation: CODEX_CONVERSATION_IMPORT_CONFIRMATION,
    parseImport: () => { parseCount += 1; return parsed },
  })

  assert.equal(await handler({ sender: otherSender }), null)
  assert.equal(await handler({ sender: {} }), null)
  assert.equal((await handler({ sender: targetSender })).id, parsed.id)
  assert.equal((await handler({ sender: targetSender })).id, parsed.id)
  assert.equal(parseCount, 1)
  assert.throws(() => createCodexConversationImportHandler({
    isAuthorized: () => true,
    identityForWebContents: () => ({ id: '97dc48e2-1118-453a-bdb6-40b65e98ba38', kind: 'isolated' }),
    transcriptPath,
    historyPath,
    projectPath,
    targetWorkspaceId: '97dc48e2-1118-453a-bdb6-40b65e98ba38',
    confirmation: 'yes',
  }), /IMPORT CODEX/)
})

test('an actively written partial final line is excluded but corrupt complete lines fail closed', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-codex-import-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = readFileSync(transcriptPath, 'utf8')
  const partialPath = join(directory, 'partial.jsonl')
  writeFileSync(partialPath, `${source}{"unfinished":`, 'utf8')
  const partial = parseCodexConversationImport({
    transcriptPath: partialPath, historyPath, projectPath,
    now: () => '2026-08-07T12:00:00.000Z',
  }, dependencies)
  assert.equal(partial.report.transcriptIncompleteTailExcluded, true)
  assert.equal(partial.chat.messages.length, 4)

  const corruptPath = join(directory, 'corrupt.jsonl')
  writeFileSync(corruptPath, `${source}{"corrupt":\n`, 'utf8')
  assert.throws(() => parseCodexConversationImport({
    transcriptPath: corruptPath, historyPath, projectPath,
  }, dependencies), /invalid JSON on complete line/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createWorkspaceRecoveryHandler,
  MAX_WORKSPACE_RECOVERY_BYTES,
} from '../src/workspace-recovery.mjs'

const ENVELOPE = JSON.stringify({
  format: 'ensync-workspace', version: 3, revision: 1,
  committedAt: '2026-08-07T10:00:00.000Z', checksum: 'checksum', payload: '{}',
})

test('recovery IPC exposes only the operator-selected artifact to the canonical window', async () => {
  const canonicalSender = {}
  const isolatedSender = {}
  const handler = createWorkspaceRecoveryHandler({
    isAuthorized: (event) => [canonicalSender, isolatedSender].includes(event.sender),
    identityForWebContents: (sender) => ({
      id: sender === canonicalSender
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222',
      kind: sender === canonicalSender ? 'canonical' : 'isolated',
    }),
    recoveryFilePath: '/operator/recovery.json',
    fileStat: () => ({ isFile: () => true, size: ENVELOPE.length }),
    readFile: () => ENVELOPE,
  })
  const candidate = await handler({ sender: canonicalSender })
  assert.match(candidate.id, /^[0-9a-f]{64}$/)
  assert.equal(candidate.encoded, ENVELOPE)
  assert.equal(await handler({ sender: isolatedSender }), null)
  assert.equal(await handler({ sender: {} }), null)
})

test('recovery IPC rejects invalid and oversized files without returning bytes', async () => {
  const sender = {}
  const common = {
    isAuthorized: () => true,
    identityForWebContents: () => ({ id: '11111111-1111-4111-8111-111111111111', kind: 'canonical' }),
    recoveryFilePath: '/operator/recovery.json',
  }
  await assert.rejects(() => createWorkspaceRecoveryHandler({
    ...common,
    fileStat: () => ({ isFile: () => true, size: MAX_WORKSPACE_RECOVERY_BYTES + 1 }),
    readFile: () => { throw new Error('must not read') },
  })({ sender }), /size limit/)
  await assert.rejects(() => createWorkspaceRecoveryHandler({
    ...common,
    fileStat: () => ({ isFile: () => true, size: 10 }),
    readFile: () => '{invalid',
  })({ sender }), /not a v3/)
})

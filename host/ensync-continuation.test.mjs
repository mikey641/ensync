import assert from 'node:assert/strict'
import test from 'node:test'
import { extractEnsyncContinuation } from '../src/lib/ensyncContinuation.mjs'

test('removes the final Ensync continuation section from the visible response', () => {
  const response = `The confirmation flow is fixed and verified.\n\n### Ensync continuation\n\n- Outcome: Complete.\n- Preserve: Keep opt-outs closed.\n- Files changed: flow.ts\n- Verification: Focused tests passed.\n- Next action: none.`

  assert.deepEqual(extractEnsyncContinuation(response), {
    visibleResponse: 'The confirmation flow is fixed and verified.',
    semanticSummary: '- Outcome: Complete.\n- Preserve: Keep opt-outs closed.\n- Files changed: flow.ts\n- Verification: Focused tests passed.\n- Next action: none.',
  })
})

test('accepts heading levels and CRLF while preserving the private handoff body', () => {
  assert.deepEqual(extractEnsyncContinuation('Done.\r\n\r\n## Ensync continuation:\r\nOutcome: complete'), {
    visibleResponse: 'Done.',
    semanticSummary: 'Outcome: complete',
  })
})

test('does not remove ordinary mentions or headings inside fenced code', () => {
  const inline = 'Do not print an Ensync continuation section to the user.'
  const fenced = 'Example:\n```md\n### Ensync continuation\nOutcome: example\n```'

  assert.deepEqual(extractEnsyncContinuation(inline), { visibleResponse: inline, semanticSummary: null })
  assert.deepEqual(extractEnsyncContinuation(fenced), { visibleResponse: fenced, semanticSummary: null })
})

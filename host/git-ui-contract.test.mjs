import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('the Git UI has no manual landing review path when automatic landing is always on', async () => {
  const modal = await readFile(join(root, 'src/components/GitWorkflowModal.tsx'), 'utf8')
  const styles = await readFile(join(root, 'src/components/GitWorkflowModal.css'), 'utf8')

  assert.doesNotMatch(modal, /Unlanded agent work/)
  assert.doesNotMatch(modal, /landGitBranch/)
  assert.doesNotMatch(styles, /git-unlanded/)
})

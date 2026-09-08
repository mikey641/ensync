import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const appCssPath = new URL('../src/index.css', import.meta.url)
const ensyncHostPath = new URL('../src/lib/ensyncHost.ts', import.meta.url)

test('the production disclosure streams the automatic repair job live without owning it', async () => {
  const [app, css, ensyncHost] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(appCssPath, 'utf8'),
    readFile(ensyncHostPath, 'utf8'),
  ])

  // A read-only observer: detaching from the stream must never cancel the Host job.
  assert.match(ensyncHost, /async observeChatJob\(/)
  assert.match(ensyncHost, /observeChatJob\([\s\S]*?cancelOnAbort: false/)
  assert.match(ensyncHost, /async attachChatJob\([\s\S]*?cancelOnAbort: true/)

  // The panel follows the delivery record's repair job while the record is repairing.
  assert.match(app, /function useRepairJobEvents\(/)
  assert.match(app, /ensyncHost\.observeChatJob\(jobId/)
  assert.match(app, /const repairJobId = delivery\?\.state === 'repairing' \? delivery\.repairJobId : null/)
  assert.match(app, /useRepairJobEvents\(repairJobId\)/)

  // Provider notes are rendered live, the same CLI-visible notes a chat shows.
  assert.match(app, /className="delivery-panel__repair"/)
  assert.match(app, /Live repair notes/)
  assert.match(app, /delivery-panel__repair-log/)
  assert.match(app, /\[\{event\.provider\} note\] \{event\.text\}/)
  assert.match(css, /\.delivery-panel__repair \{/)
  assert.match(css, /\.delivery-panel__repair-log \{/)
})

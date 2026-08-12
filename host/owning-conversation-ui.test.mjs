import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const cssPath = new URL('../src/index.css', import.meta.url)

test('the conversation pane offers exact owning-chat navigation without transferring a prompt', async () => {
  const [app, css] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
  ])

  assert.match(app, /findReferencedOwningConversation/)
  assert.match(app, /exactNativeChatFocusCanApply/)
  assert.match(app, /<OwningConversationBanner/)
  assert.match(app, /'Open owning conversation'/)
  assert.match(app, /target\.workspaceId === nativeWorkspaceIdentity\.id/)
  assert.match(app, /focusWorkspace\(target\)/)
  const handlerStart = app.indexOf('onOpenOwningConversation={async')
  const handlerEnd = app.indexOf('onSettings=', handlerStart)
  assert.notEqual(handlerStart, -1)
  assert.ok(handlerEnd > handlerStart)
  assert.doesNotMatch(app.slice(handlerStart, handlerEnd), /handoffQueuedMessage/)
  assert.match(css, /\.owning-conversation-banner/)
})

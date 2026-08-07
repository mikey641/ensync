import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const splitWorkspacePath = new URL('../src/components/SplitWorkspace.tsx', import.meta.url)
const splitWorkspaceCssPath = new URL('../src/components/SplitWorkspace.css', import.meta.url)
const appCssPath = new URL('../src/index.css', import.meta.url)
const displayPreferencesPath = new URL('../src/display-preferences.tsx', import.meta.url)

test('normal tabs, hidden tabs, and split panes share the conditional unread-completion treatment', async () => {
  const source = await readFile(splitWorkspacePath, 'utf8')

  assert.equal(source.includes('provider-dot'), false)
  assert.equal(source.includes('workspace-tab__dot'), false)
  assert.equal(source.match(/<CompletionStatus/g)?.length, 3)
  assert.match(source, /data-completion-indicator=\{completionIndicator\}/)
  assert.match(source, /isCompleted \? 'relay-tabs-mode-tab--completed'/)
  assert.match(source, /isCompleted \? 'relay-split-hidden-tab--completed'/)
  assert.match(source, /isCompleted \? 'relay-split-pane--completed'/)
})

test('the persisted display setting offers dot, green-header, and whole-tab treatments', async () => {
  const [splitCss, appCss, displayPreferences] = await Promise.all([
    readFile(splitWorkspaceCssPath, 'utf8'),
    readFile(appCssPath, 'utf8'),
    readFile(displayPreferencesPath, 'utf8'),
  ])

  assert.match(splitCss, /\.relay-split-completed-dot\s*\{[^}]*flex:\s*0 0 7px;/s)
  assert.match(splitCss, /data-completion-indicator='header'[^\n]*relay-tabs-mode-tab--completed/)
  assert.match(splitCss, /data-completion-indicator='header'[^\n]*relay-split-pane--completed/)
  assert.match(splitCss, /data-completion-indicator='tab'[^\n]*relay-tabs-mode-tab--completed/)
  assert.match(splitCss, /data-completion-indicator='tab'[^\n]*relay-split-pane--completed::after/)
  assert.match(displayPreferences, /completionIndicator: 'dot'/)
  assert.match(displayPreferences, /DISPLAY_PREFERENCES_STORAGE_KEY = 'ensync-display-preferences-v2'/)
  assert.match(displayPreferences, /LEGACY_DISPLAY_PREFERENCES_STORAGE_KEY = 'ensync-display-preferences-v1'/)
  assert.match(displayPreferences, /value: 'dot', label: 'Small dot'/)
  assert.match(displayPreferences, /value: 'header', label: 'Green header'/)
  assert.match(displayPreferences, /value: 'tab', label: 'Whole tab'/)
  assert.equal(splitCss.includes('provider-dot'), false)
  assert.equal(appCss.includes('workspace-tab__dot'), false)
})

test('the temporary largest pane can outgrow an overflowing row of tabs', async () => {
  const [source, splitCss] = await Promise.all([
    readFile(splitWorkspacePath, 'utf8'),
    readFile(splitWorkspaceCssPath, 'utf8'),
  ])

  assert.match(source, /isMaximized \? 'relay-split-pane--largest'/)
  assert.match(splitCss, /\.relay-split-viewport\s*\{[^}]*container-type:\s*inline-size;/s)
  assert.match(
    splitCss,
    /\.relay-split-pane--largest\s*\{[^}]*min-width:\s*max\(\s*66\.666cqw,\s*calc\(var\(--relay-split-min-pane\) \+ var\(--relay-split-min-pane\)\)\s*\);/s,
  )
})

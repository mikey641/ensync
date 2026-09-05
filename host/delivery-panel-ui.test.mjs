import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const appCssPath = new URL('../src/index.css', import.meta.url)
const ensyncHostPath = new URL('../src/lib/ensyncHost.ts', import.meta.url)

test('every mounted protected chat owns a collapsed branch-scoped production disclosure', async () => {
  const [app, css, ensyncHost] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(appCssPath, 'utf8'),
    readFile(ensyncHostPath, 'utf8'),
  ])

  assert.match(app, /ensyncHost\.deliveryStatus\(projectPath, deliveryBranch \?\? undefined\)/)
  assert.match(app, /if \(projectPath && deliveryBranch\) void refresh\(\)/)
  assert.doesNotMatch(app, /if \(isActive && projectPath\) void refresh\(\)/)
  assert.match(app, /deliveryPanelOpen=\{deliveryPanelOpenForChat\(deliveryPanelOpenByChat, chat\.id\)\}/)
  assert.match(app, /\{deliveryBranch && \(\s*<DeliveryPanel/)
  assert.match(app, /delivery: DeliveryRecord \| null/)
  assert.match(app, /productionDelivery: DeliveryRecord \| null/)
  assert.match(app, /const delivery = projectDelivery\?\.current \?\? null/)
  assert.match(app, /const productionDelivery = projectDelivery\?\.production \?\? null/)
  assert.match(app, /No saved delivery exists for this chat yet/)
  assert.match(app, /<strong>Production delivery<\/strong>/)
  assert.match(app, /<em>\{promptScope\} · \{promptLabel\}<\/em>/)
  assert.match(app, /if \(promptIsActive\) return 'Running'/)
  assert.match(app, /Earlier delivery · \$\{deliveryLabelText\}/)
  assert.match(app, /<strong>This chat only<\/strong>[\s\S]*?<code title=\{sourceBranch\}>\{sourceBranch\}<\/code>/)
  assert.match(app, /deliveryTracksPrompt \? 'Open this prompt’s' : 'Open earlier work’s'/)
  assert.match(app, /delivery\?\.state === 'production'/)
  assert.match(app, /Merging by Ensync/)
  assert.match(app, /const landingStepLabel = delivery\?\.state === 'landing' \? deliveryLabel\(delivery\) : 'Landing'/)
  assert.match(app, /const deliverySteps = \['Saved', landingStepLabel, 'Pushed', 'Building', 'Production'\]/)
  assert.match(app, /Earlier delivered work/)
  assert.match(app, /No saved delivery is linked to this prompt/)
  assert.match(app, /deliveryPromptContext\([\s\S]*?activeTurnId/)
  assert.match(app, /executionEvents=\{executionEvents\}/)
  assert.match(app, /recovered the missing legacy link from immutable run evidence/)
  assert.match(app, /sending \? 'Live CLI execution' : 'Previous CLI execution'/)
  assert.match(app, /sending \? 'Latest note' : 'Last run note'/)
  assert.match(app, /deliveryWorkDescription\(delivery, messages\)/)
  assert.match(app, /Earlier verified production/)
  assert.match(app, /This is not the current saved prompt/)
  assert.match(app, /<h3>Delivery destination<\/h3>/)
  assert.match(app, />Production<\/strong>/)
  assert.match(app, />Protected branch only<\/strong>/)
  assert.match(app, /deliveryTarget: runDeliveryTarget/)
  assert.match(app, /health\.capabilities\?\.deliveryTargets\?\.includes\('protected_branch'\)/)
  assert.match(app, /nothing was started/i)
  assert.match(app, /<DeliveryPanel[\s\S]*?open=\{deliveryPanelOpen\}[\s\S]*?onOpenChange=\{onDeliveryPanelOpenChange\}/)
  assert.match(app, /className="delivery-panel__header"[\s\S]*?aria-expanded=\{open\}/)
  assert.doesNotMatch(app, /delivery-card/)

  assert.match(css, /\.delivery-panel\s*\{[^}]*width:\s*min\(720px,[^}]*overflow:\s*hidden;/s)
  assert.match(css, /\.delivery-panel__header\s*\{[^}]*cursor:\s*pointer;/s)
  assert.match(css, /\.delivery-panel__header > strong\s*\{[^}]*font-size:\s*var\(--font-label\);/s)
  assert.match(css, /\.delivery-panel__owner\s*\{[^}]*font-size:\s*var\(--font-label\);/s)
  assert.match(css, /\.delivery-panel__work > strong[^}]*font-size:\s*var\(--font-ui\);/s)
  assert.match(css, /\.production-delivery-setting \.choice-row > button\s*\{[^}]*grid-template-columns:\s*20px minmax\(0, 1fr\) 18px;/s)
  assert.equal(css.includes('.delivery-card'), false)
  assert.match(ensyncHost, /scopeDeliveryStatusForBranch\(response\.delivery, sourceBranch\)/)
})

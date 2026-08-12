import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  activeWorkspaceOverlaps,
  workspaceOverlapSummary,
} from '../src/lib/workspaceOverlap.mjs'

const appPath = new URL('../src/App.tsx', import.meta.url)
const appCssPath = new URL('../src/index.css', import.meta.url)

function detected(peerBranch, paths, source = 'active') {
  return {
    type: 'notice',
    code: 'workspace_file_overlap_detected',
    message: 'overlap',
    overlap: {
      peerBranch,
      state: 'detected',
      source,
      paths,
      totalCount: paths.length,
    },
    at: '2026-08-12T12:00:00.000Z',
  }
}

function cleared(peerBranch) {
  return {
    type: 'notice',
    code: 'workspace_file_overlap_cleared',
    message: 'clear',
    overlap: {
      peerBranch,
      state: 'cleared',
      source: 'active',
      paths: [],
      totalCount: 0,
    },
    at: '2026-08-12T12:00:01.000Z',
  }
}

test('detected and cleared events rebuild only current overlaps after reconnect', () => {
  const events = [
    detected('ensync/chat-peer-a', ['src/App.tsx']),
    detected('ensync/chat-peer-b', ['host/git.mjs']),
    cleared('ensync/chat-peer-a'),
    { ...detected('ensync/chat-malformed', ['../secret']), overlap: { state: 'detected' } },
  ]

  assert.deepEqual(
    activeWorkspaceOverlaps(events).map((item) => item.peerBranch),
    ['ensync/chat-peer-b'],
  )
})

test('an active peer becoming unlanded survives the older-source clear event', () => {
  const events = [
    detected('ensync/chat-peer-a', ['src/App.tsx']),
    detected('ensync/chat-peer-a', ['src/App.tsx'], 'unlanded'),
    cleared('ensync/chat-peer-a'),
  ]

  assert.deepEqual(activeWorkspaceOverlaps(events), [{
    peerBranch: 'ensync/chat-peer-a',
    state: 'detected',
    source: 'unlanded',
    paths: ['src/App.tsx'],
    totalCount: 1,
  }])
})

test('multiple peers aggregate unique paths into bounded accessible copy', () => {
  const overlaps = activeWorkspaceOverlaps([
    detected('ensync/chat-peer-a', ['src/App.tsx', 'host/git.mjs', 'README.md']),
    detected('ensync/chat-peer-b', ['src/App.tsx', 'src/index.css', 'package.json'], 'unlanded'),
  ])
  const summary = workspaceOverlapSummary(overlaps, {
    'ensync/chat-peer-a': 'Settings refactor',
  })

  assert.deepEqual(summary.paths, ['README.md', 'host/git.mjs', 'package.json'])
  assert.equal(summary.remainingCount, 2)
  assert.match(summary.message, /^Settings refactor and 1 other Ensync conversation are editing or have unlanded changes in /)
  assert.match(summary.message, /README\.md, host\/git\.mjs, package\.json and 2 other files\./)
  assert.match(summary.message, /Work can continue; Ensync will recheck before landing\.$/)
})

test('the warning is a persistent status outside the collapsible execution output', async () => {
  const [app, css] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(appCssPath, 'utf8'),
  ])
  const invocation = app.indexOf('{workspaceOverlap && <WorkspaceOverlapBanner')
  const executionPanel = app.indexOf('<ExecutionPanel')
  const composer = app.indexOf('<div className="composer-zone"', executionPanel)

  assert.ok(executionPanel >= 0 && invocation > executionPanel && invocation < composer)
  assert.match(app, /className="workspace-overlap-banner" role="status"/)
  assert.match(app, /<AlertTriangle size=\{16\}/)
  assert.match(css, /\.workspace-overlap-banner\s*\{[^}]*overflow-wrap:\s*anywhere;/s)
  assert.match(css, /\.conversation \.workspace-overlap-banner\s*\{[^}]*width:\s*calc\(100% - 20px\);/s)
})

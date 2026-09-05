import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SupportService,
  SupportValidationError,
  collectSupportDiagnostics,
  prepareGitHubIssueUrl,
  supportAvailability,
} from './support.mjs'

const fixedNow = () => new Date('2026-08-06T10:00:00.000Z')

function providerFixture() {
  return {
    id: 'claude',
    installed: true,
    executable: '/Users/alice/private/bin/claude',
    version: '2.4.1',
    connectionState: 'ready',
    authentication: {
      state: 'authenticated',
      reason: 'token secret-123 was loaded',
    },
    chatExecution: 'supported',
    availableModels: [{ id: 'private-model', displayName: 'Private Model' }],
    usage: { plan: 'Personal Max', usedPercent: 90 },
  }
}

function projectFixture() {
  return {
    id: 'local-safe-id',
    name: 'sample-project',
    path: '/Users/alice/secret-customer/sample-project',
    host: 'local',
    context: {
      ensyncDirectory: true,
      files: ['project.md', 'features/secret-client.md'],
      featureFiles: ['features/secret-client.md'],
      truncated: false,
      error: null,
      instructionAdapters: [
        { provider: 'claude', file: 'CLAUDE.md' },
        { provider: 'codex', file: 'AGENTS.md' },
      ],
    },
  }
}

test('diagnostics include only whitelisted provider and project facts', async () => {
  const diagnostics = await collectSupportDiagnostics({
    statusService: { list: async () => [providerFixture()] },
    projectService: { current: async () => projectFixture() },
    appVersion: '0.1.0',
    buildChannel: 'development',
    now: fixedNow,
  })
  const serialized = JSON.stringify(diagnostics)

  assert.deepEqual(diagnostics.providers, {
    available: true,
    items: [{
      id: 'claude',
      installed: true,
      version: '2.4.1',
      connectionState: 'ready',
      authenticationState: 'authenticated',
      chatExecution: 'supported',
    }],
  })
  assert.deepEqual(diagnostics.project, {
    available: true,
    value: {
      selected: true,
      id: 'local-safe-id',
      name: 'sample-project',
      host: 'local',
      ensyncDirectory: true,
      ensyncFileCount: 2,
      featureFileCount: 1,
      instructionAdapters: ['claude', 'codex'],
      contextTruncated: false,
      contextInspectionSucceeded: true,
    },
  })
  assert.equal(serialized.includes('/Users/alice'), false)
  assert.equal(serialized.includes('secret-123'), false)
  assert.equal(serialized.includes('secret-client.md'), false)
  assert.equal(serialized.includes('Personal Max'), false)
  assert.equal(serialized.includes('private-model'), false)
  assert.equal(diagnostics.privacy.chatTextAutomaticallyCollected, false)
  assert.equal(diagnostics.privacy.fileContentsAutomaticallyCollected, false)
  assert.equal(diagnostics.privacy.userProvidedTicketTextIncluded, true)
})

test('project context can be excluded and failed probes remain honest', async () => {
  const diagnostics = await collectSupportDiagnostics({
    statusService: { list: async () => { throw new Error('token=private') } },
    projectService: { current: async () => projectFixture() },
    includeProjectContext: false,
    now: fixedNow,
  })

  assert.deepEqual(diagnostics.providers, {
    available: false,
    reason: 'Provider diagnostics could not be collected.',
  })
  assert.deepEqual(diagnostics.project, {
    available: false,
    reason: 'Project diagnostics were excluded by the user.',
  })
  assert.equal(JSON.stringify(diagnostics).includes('token=private'), false)
})

test('service creates an unreviewed local draft without making external claims', async () => {
  let nextId = 0
  const service = new SupportService({
    statusService: { list: async () => [providerFixture()] },
    projectService: { current: async () => projectFixture() },
    githubIssuesUrl: 'https://github.com/ensync-app/ensync/issues/new',
    appVersion: '0.1.0',
    now: fixedNow,
    id: () => `ticket-${++nextId}`,
  })
  const result = await service.preview({
    category: 'bug',
    summary: 'Split pane is misaligned',
    description: 'The tab header is wider than the pane.',
  })

  assert.equal(result.report.ticket.id, 'ticket-1')
  assert.equal(result.report.ticket.status, 'local_draft')
  assert.equal(result.report.review.reviewedAt, null)
  assert.equal(result.report.review.externalSubmission, false)
  assert.equal(result.availability.githubIssues.available, true)
  assert.equal(result.availability.humanHelpDesk.available, false)
  assert.equal(result.availability.humanHelpDesk.responseSla, null)
})

test('service validates ticket fields before producing a usable report', async () => {
  const service = new SupportService({ now: fixedNow })
  await assert.rejects(
    service.preview({ category: 'not-real', summary: 'Summary', description: 'Description' }),
    (error) => error instanceof SupportValidationError && error.code === 'invalid_category',
  )
  await assert.rejects(
    service.preview({ category: 'bug', summary: ' ', description: 'Description' }),
    (error) => error instanceof SupportValidationError && error.code === 'missing_summary',
  )
})

test('GitHub integration prepares a reviewed draft URL and never submits', async () => {
  const service = new SupportService({
    githubIssuesUrl: 'https://github.com/ensync-app/ensync/issues/new',
    now: fixedNow,
    id: () => 'ticket-1',
  })
  const preview = await service.preview({
    category: 'bug',
    summary: 'Composer disappeared',
    description: 'The chat composer is no longer visible.',
    includeProjectContext: false,
  })
  const result = service.prepareGitHubIssue({ report: preview.report, reviewed: true })
  const url = new URL(result.issue.url)

  assert.equal(result.issue.submitted, false)
  assert.equal(result.issue.mode, 'prepare_url_only')
  assert.equal(result.report.review.reviewedAt, '2026-08-06T10:00:00.000Z')
  assert.equal(url.origin, 'https://github.com')
  assert.equal(url.pathname, '/ensync-app/ensync/issues/new')
  assert.equal(url.searchParams.get('title'), '[bug] Composer disappeared')
  assert.match(url.searchParams.get('body'), /"externalSubmission": false/)
})

test('GitHub URL preparation requires review and a strict GitHub issues URL', () => {
  const report = {
    schemaVersion: 1,
    ticket: { category: 'bug', summary: 'Summary', description: 'Description' },
    review: { reviewedAt: null },
  }
  assert.throws(
    () => prepareGitHubIssueUrl(report, 'https://github.com/owner/repository/issues/new'),
    (error) => error instanceof SupportValidationError && error.code === 'review_required',
  )
  assert.equal(supportAvailability({ githubIssuesUrl: 'https://example.com/issues/new' }).githubIssues.available, false)
})

test('service requires an explicit reviewed flag before preparing an issue', async () => {
  const service = new SupportService({
    githubIssuesUrl: 'https://github.com/ensync-app/ensync/issues/new',
    now: fixedNow,
  })
  const preview = await service.preview({
    category: 'bug',
    summary: 'Summary',
    description: 'Description',
  })
  assert.throws(
    () => service.prepareGitHubIssue({ report: preview.report }),
    (error) => error instanceof SupportValidationError && error.code === 'review_required',
  )
})

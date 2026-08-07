import { randomUUID } from 'node:crypto'
import { arch, platform, release } from 'node:os'

const REPORT_SCHEMA_VERSION = 1
const MAX_SUMMARY_LENGTH = 160
const MAX_DESCRIPTION_LENGTH = 20_000
const MAX_GITHUB_URL_LENGTH = 48_000
const SUPPORT_CATEGORIES = new Set([
  'bug',
  'connection',
  'usage',
  'git',
  'remote',
  'telegram',
  'other',
])

function isoNow(now) {
  return now().toISOString()
}

function cleanSingleLine(value, maximumLength) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximumLength)
}

function cleanDescription(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\u0000/g, '').trim().slice(0, MAX_DESCRIPTION_LENGTH)
}

function safeVersion(value) {
  return cleanSingleLine(value, 120) || null
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function configuredGitHubIssuesUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    const parts = url.pathname.split('/').filter(Boolean)
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || parts.length !== 4
      || parts[2] !== 'issues'
      || parts[3] !== 'new'
      || url.username
      || url.password
      || url.hash
    ) return null
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

function providerDiagnostic(provider) {
  return {
    id: cleanSingleLine(provider?.id, 40) || 'unknown',
    installed: provider?.installed === true,
    version: safeVersion(provider?.version),
    connectionState: cleanSingleLine(provider?.connectionState, 60) || 'unknown',
    authenticationState: cleanSingleLine(provider?.authentication?.state, 60) || 'unknown',
    chatExecution: cleanSingleLine(provider?.chatExecution, 60) || 'unknown',
  }
}

function projectDiagnostic(project) {
  if (!project || typeof project !== 'object') return null
  const adapters = Array.isArray(project.context?.instructionAdapters)
    ? project.context.instructionAdapters.map((adapter) => cleanSingleLine(adapter?.provider, 40)).filter(Boolean)
    : []
  return {
    selected: true,
    id: cleanSingleLine(project.id, 80) || null,
    name: cleanSingleLine(project.name, 120) || null,
    host: cleanSingleLine(project.host, 40) || 'unknown',
    relayDirectory: project.context?.relayDirectory === true,
    relayFileCount: safeCount(project.context?.files?.length),
    featureFileCount: safeCount(project.context?.featureFiles?.length),
    instructionAdapters: adapters,
    contextTruncated: project.context?.truncated === true,
    contextInspectionSucceeded: !project.context?.error,
  }
}

function unavailableDiagnostic(reason) {
  return {
    available: false,
    reason,
  }
}

export class SupportValidationError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'SupportValidationError'
    this.code = code
    this.status = status
  }
}

export function supportAvailability(options = {}) {
  const githubIssuesUrl = configuredGitHubIssuesUrl(options.githubIssuesUrl)
  return {
    localReports: {
      available: true,
      storage: 'browser_local',
      reason: 'Reports are previewed and downloaded locally. Ensync Host does not upload them.',
    },
    humanHelpDesk: {
      available: false,
      responseSla: null,
      reason: 'No staffed help desk or response SLA is configured.',
    },
    githubIssues: {
      available: Boolean(githubIssuesUrl),
      mode: 'prepare_url_only',
      url: githubIssuesUrl,
      reason: githubIssuesUrl
        ? 'Ensync can prepare a GitHub issue draft URL after review; it never submits the issue.'
        : 'No GitHub issue tracker is configured for this build.',
    },
    aiRepair: {
      available: false,
      reason: 'Availability depends on a focused project and a connected subscription CLI in the app.',
    },
    checkedAt: options.checkedAt ?? new Date().toISOString(),
  }
}

/**
 * Builds a deliberately small diagnostic envelope. Values such as executable
 * paths, auth reasons, model prompts, transcripts, file names and file contents
 * are never copied from the supplied services.
 */
export async function collectSupportDiagnostics(options = {}) {
  const now = options.now ?? (() => new Date())
  const diagnostics = {
    collectedAt: isoNow(now),
    app: {
      name: 'Ensync',
      version: safeVersion(options.appVersion),
      buildChannel: safeVersion(options.buildChannel),
    },
    runtime: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      nodeVersion: process.version,
    },
    providers: unavailableDiagnostic('Provider status service is unavailable.'),
    project: options.includeProjectContext === false
      ? unavailableDiagnostic('Project diagnostics were excluded by the user.')
      : unavailableDiagnostic('Project inspection service is unavailable.'),
    privacy: {
      chatTextAutomaticallyCollected: false,
      secretsAutomaticallyCollected: false,
      fileContentsAutomaticallyCollected: false,
      absolutePathsAutomaticallyCollected: false,
      environmentVariablesAutomaticallyCollected: false,
      commandOutputAutomaticallyCollected: false,
      userProvidedTicketTextIncluded: true,
      note: 'Only the whitelisted diagnostic fields visible in this preview are collected automatically. The user-provided summary and description are included as written.',
    },
  }

  if (options.statusService?.list) {
    try {
      const providers = await options.statusService.list({ refresh: false })
      diagnostics.providers = {
        available: true,
        items: Array.isArray(providers) ? providers.map(providerDiagnostic) : [],
      }
    } catch {
      diagnostics.providers = unavailableDiagnostic('Provider diagnostics could not be collected.')
    }
  }

  if (options.includeProjectContext !== false && options.projectService?.current) {
    try {
      const project = await options.projectService.current()
      diagnostics.project = {
        available: true,
        value: projectDiagnostic(project),
      }
    } catch {
      diagnostics.project = unavailableDiagnostic('Project diagnostics could not be collected.')
    }
  }

  return diagnostics
}

export function validateSupportTicketInput(input = {}) {
  const category = cleanSingleLine(input.category, 40)
  const summary = cleanSingleLine(input.summary, MAX_SUMMARY_LENGTH)
  const description = cleanDescription(input.description)
  if (!SUPPORT_CATEGORIES.has(category)) {
    throw new SupportValidationError('invalid_category', 'Choose a valid support category.')
  }
  if (!summary) {
    throw new SupportValidationError('missing_summary', 'Add a short summary of the problem.')
  }
  if (!description) {
    throw new SupportValidationError('missing_description', 'Describe what happened and what you expected.')
  }
  return { category, summary, description }
}

export function buildSupportReport(input, diagnostics, options = {}) {
  const ticket = validateSupportTicketInput(input)
  const now = options.now ?? (() => new Date())
  const createdAt = isoNow(now)
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    ticket: {
      id: options.id ?? randomUUID(),
      status: 'local_draft',
      category: ticket.category,
      summary: ticket.summary,
      description: ticket.description,
      createdAt,
    },
    diagnostics,
    review: {
      requiredBeforeExport: true,
      reviewedAt: null,
      externalSubmission: false,
      note: 'The summary and description are user-provided. Review them and the diagnostics before downloading or sharing.',
    },
  }
}

export function markSupportReportReviewed(report, options = {}) {
  if (!report || typeof report !== 'object' || report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new SupportValidationError('invalid_report', 'The support report is invalid.')
  }
  const now = options.now ?? (() => new Date())
  return {
    ...report,
    review: {
      ...report.review,
      reviewedAt: isoNow(now),
      externalSubmission: false,
    },
  }
}

export function prepareGitHubIssueUrl(report, githubIssuesUrl) {
  const baseUrl = configuredGitHubIssuesUrl(githubIssuesUrl)
  if (!baseUrl) {
    throw new SupportValidationError('github_unavailable', 'No GitHub issue tracker is configured.', 409)
  }
  if (!report?.review?.reviewedAt) {
    throw new SupportValidationError('review_required', 'Review the support report before preparing an issue.', 409)
  }
  const title = `[${report.ticket.category}] ${report.ticket.summary}`
  const body = [
    report.ticket.description,
    '',
    '### Ensync support report',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    '_Prepared locally by Ensync. Opening this draft does not submit the issue._',
  ].join('\n')
  const url = new URL(baseUrl)
  url.searchParams.set('title', title)
  url.searchParams.set('body', body)
  if (url.toString().length > MAX_GITHUB_URL_LENGTH) {
    throw new SupportValidationError(
      'issue_url_too_large',
      'The reviewed report is too large for a GitHub issue URL. Download the JSON report instead.',
      413,
    )
  }
  return {
    url: url.toString(),
    submitted: false,
    mode: 'prepare_url_only',
    warning: 'Opening this URL shares the reviewed draft with GitHub. GitHub still requires you to submit it.',
  }
}

export class SupportService {
  constructor(options = {}) {
    this.statusService = options.statusService
    this.projectService = options.projectService
    this.githubIssuesUrl = configuredGitHubIssuesUrl(options.githubIssuesUrl)
    this.appVersion = options.appVersion ?? null
    this.buildChannel = options.buildChannel ?? null
    this.now = options.now ?? (() => new Date())
    this.id = options.id ?? (() => randomUUID())
  }

  status() {
    return supportAvailability({
      githubIssuesUrl: this.githubIssuesUrl,
      checkedAt: isoNow(this.now),
    })
  }

  async preview(input = {}) {
    const diagnostics = await collectSupportDiagnostics({
      statusService: this.statusService,
      projectService: this.projectService,
      includeProjectContext: input.includeProjectContext !== false,
      appVersion: this.appVersion,
      buildChannel: this.buildChannel,
      now: this.now,
    })
    return {
      report: buildSupportReport(input, diagnostics, {
        id: this.id(),
        now: this.now,
      }),
      availability: this.status(),
    }
  }

  prepareGitHubIssue(input = {}) {
    if (input.reviewed !== true) {
      throw new SupportValidationError(
        'review_required',
        'Confirm that you reviewed the support report before preparing an issue.',
        409,
      )
    }
    const report = markSupportReportReviewed(input.report, { now: this.now })
    return {
      issue: prepareGitHubIssueUrl(report, this.githubIssuesUrl),
      report,
    }
  }
}

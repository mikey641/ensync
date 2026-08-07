import { useEffect, useId, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileJson,
  LifeBuoy,
  LoaderCircle,
  ShieldCheck,
  TicketCheck,
  X,
} from 'lucide-react'
import {
  buildAiRepairPrompt,
  downloadSupportReport,
  markSupportReportReviewed,
  supportHost,
  type LocalSupportTicket,
  type LocalSupportTicketStatus,
  type SupportAvailability,
  type SupportCategory,
  type SupportHostClient,
  type SupportRepairProvider,
  type SupportRepairResponse,
  type SupportReport,
} from '../lib/supportHost'
import './SupportDesk.css'

const SUPPORT_TICKETS_STORAGE = 'ensync-support-tickets-v1'
const MAX_LOCAL_TICKETS = 50

const CATEGORIES: Array<{ id: SupportCategory; label: string }> = [
  { id: 'bug', label: 'Bug' },
  { id: 'connection', label: 'CLI connection' },
  { id: 'usage', label: 'Usage reporting' },
  { id: 'git', label: 'Git workflow' },
  { id: 'remote', label: 'Remote runtime' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'other', label: 'Other' },
]

const STATUS_LABELS: Record<LocalSupportTicketStatus, string> = {
  report_ready: 'Report ready',
  downloaded: 'Downloaded',
  github_draft_opened: 'GitHub draft opened',
  ai_fix_started: 'AI repair started',
  resolved_locally: 'Resolved locally',
}

export type SupportAiRepairAvailability = {
  available: boolean
  providerName?: string
  reason: string
  target?: {
    provider: SupportRepairProvider
    projectId: string
    projectPath: string
    sessionId?: string | null
    model?: string | null
  }
}

export type SupportDeskProps = {
  client?: SupportHostClient
  aiRepair?: SupportAiRepairAvailability
  onStartAiRepair?: (input: {
    ticket: LocalSupportTicket
    report: SupportReport
    prompt: string
  }) => void | Promise<void>
  onAiRepairCompleted?: (result: SupportRepairResponse) => void
  onClose?: () => void
  className?: string
}

function readLocalTickets() {
  if (typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SUPPORT_TICKETS_STORAGE) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is LocalSupportTicket => {
      if (!item || typeof item !== 'object') return false
      const candidate = item as Partial<LocalSupportTicket>
      return typeof candidate.id === 'string'
        && typeof candidate.summary === 'string'
        && typeof candidate.createdAt === 'string'
        && typeof candidate.updatedAt === 'string'
        && typeof candidate.category === 'string'
        && typeof candidate.status === 'string'
    }).slice(0, MAX_LOCAL_TICKETS)
  } catch {
    return []
  }
}

function storeLocalTickets(tickets: LocalSupportTicket[]) {
  try {
    window.localStorage.setItem(SUPPORT_TICKETS_STORAGE, JSON.stringify(tickets.slice(0, MAX_LOCAL_TICKETS)))
  } catch {
    // Local ticket tracking is a convenience; storage failure must not block report export.
  }
}

function safeError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function SupportDesk({
  client = supportHost,
  aiRepair = {
    available: false,
    reason: 'Select a project and connect a supported subscription CLI to enable AI repair.',
  },
  onStartAiRepair,
  onAiRepairCompleted,
  onClose,
  className = '',
}: SupportDeskProps) {
  const id = useId()
  const [availability, setAvailability] = useState<SupportAvailability | null>(null)
  const [category, setCategory] = useState<SupportCategory>('bug')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [includeProjectContext, setIncludeProjectContext] = useState(true)
  const [report, setReport] = useState<SupportReport | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [repairConsent, setRepairConsent] = useState(false)
  const [tickets, setTickets] = useState<LocalSupportTicket[]>(readLocalTickets)
  const [busy, setBusy] = useState<'preview' | 'github' | 'ai' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [repairResult, setRepairResult] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void client.status().then((status) => {
      if (!cancelled) setAvailability(status)
    }).catch((statusError: unknown) => {
      if (!cancelled) setError(safeError(statusError, 'Ensync Host support status is unavailable.'))
    })
    return () => { cancelled = true }
  }, [client])

  const replaceTickets = (next: LocalSupportTicket[]) => {
    const limited = next.slice(0, MAX_LOCAL_TICKETS)
    setTickets(limited)
    storeLocalTickets(limited)
  }

  const updateTicketStatus = (ticketId: string, status: LocalSupportTicketStatus) => {
    const updatedAt = new Date().toISOString()
    replaceTickets(tickets.map((ticket) => ticket.id === ticketId
      ? { ...ticket, status, updatedAt }
      : ticket))
  }

  const invalidatePreview = () => {
    setReport(null)
    setReviewed(false)
    setRepairConsent(false)
    setRepairResult(null)
    setNotice(null)
    setError(null)
  }

  const createPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!summary.trim() || !description.trim() || busy) return
    setBusy('preview')
    setError(null)
    setNotice(null)
    setReviewed(false)
    try {
      const result = await client.preview({
        category,
        summary: summary.trim(),
        description: description.trim(),
        includeProjectContext,
      })
      setAvailability(result.availability)
      setReport(result.report)
      const ticket: LocalSupportTicket = {
        id: result.report.ticket.id,
        summary: result.report.ticket.summary,
        category: result.report.ticket.category,
        status: 'report_ready',
        createdAt: result.report.ticket.createdAt,
        updatedAt: result.report.ticket.createdAt,
      }
      replaceTickets([ticket, ...tickets.filter((item) => item.id !== ticket.id)])
      setNotice('A private report preview is ready. Nothing was uploaded or submitted.')
    } catch (previewError) {
      setReport(null)
      setError(safeError(previewError, 'The local support report could not be prepared.'))
    } finally {
      setBusy(null)
    }
  }

  const reviewedReport = () => {
    if (!report || !reviewed) throw new Error('Review and confirm the report before continuing.')
    const nextReport = markSupportReportReviewed(report)
    setReport(nextReport)
    return nextReport
  }

  const download = () => {
    try {
      const nextReport = reviewedReport()
      downloadSupportReport(nextReport)
      updateTicketStatus(nextReport.ticket.id, 'downloaded')
      setNotice('The reviewed JSON report was downloaded to this computer.')
      setError(null)
    } catch (downloadError) {
      setError(safeError(downloadError, 'The report could not be downloaded.'))
    }
  }

  const openGitHubDraft = async () => {
    if (!report || !reviewed || busy) return
    setBusy('github')
    setError(null)
    setNotice(null)
    try {
      const result = await client.prepareGitHubIssue(report)
      setReport(result.report)
      const anchor = document.createElement('a')
      anchor.href = result.issue.url
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
      anchor.click()
      updateTicketStatus(result.report.ticket.id, 'github_draft_opened')
      setNotice('GitHub opened an unsent issue draft. Review it there before submitting.')
    } catch (githubError) {
      setError(safeError(githubError, 'The GitHub issue draft could not be prepared.'))
    } finally {
      setBusy(null)
    }
  }

  const startAiRepair = async () => {
    if (!report || !reviewed || !repairConsent || !aiRepair.available || busy) return
    setBusy('ai')
    setError(null)
    setNotice(null)
    try {
      const nextReport = reviewedReport()
      const ticket = tickets.find((item) => item.id === nextReport.ticket.id) ?? {
        id: nextReport.ticket.id,
        summary: nextReport.ticket.summary,
        category: nextReport.ticket.category,
        status: 'report_ready' as const,
        createdAt: nextReport.ticket.createdAt,
        updatedAt: nextReport.ticket.createdAt,
      }
      if (onStartAiRepair) {
        await onStartAiRepair({
          ticket,
          report: nextReport,
          prompt: buildAiRepairPrompt(nextReport),
        })
      } else if (aiRepair.target) {
        const result = await client.repair({
          provider: aiRepair.target.provider,
          projectId: aiRepair.target.projectId,
          projectPath: aiRepair.target.projectPath,
          prompt: nextReport.ticket.description,
          diagnostics: {
            summary: nextReport.ticket.summary,
            details: JSON.stringify(nextReport.diagnostics, null, 2),
          },
          consent: {
            fixWithMySubscription: true,
            allowProjectEdits: true,
          },
          sessionId: aiRepair.target.sessionId ?? null,
          model: aiRepair.target.model ?? null,
        })
        setRepairResult(result.run.response)
        onAiRepairCompleted?.(result)
      } else {
        throw new Error('The selected subscription repair target is incomplete.')
      }
      updateTicketStatus(nextReport.ticket.id, 'ai_fix_started')
      setNotice(`The reviewed report was handed to ${aiRepair.providerName ?? 'your selected subscription CLI'}. Review the CLI result and project changes; Ensync has not marked the bug fixed.`)
    } catch (repairError) {
      setError(safeError(repairError, 'The AI repair task could not be started.'))
    } finally {
      setBusy(null)
    }
  }

  const githubAvailable = availability?.githubIssues.available === true
  const repairAvailable = aiRepair.available && Boolean(onStartAiRepair || aiRepair.target)

  return (
    <section className={`ensync-support ${className}`.trim()} aria-labelledby={`${id}-title`}>
      <header className="ensync-support__header">
        <span className="ensync-support__icon" aria-hidden="true"><LifeBuoy size={21} /></span>
        <div>
          <span>SUPPORT DESK</span>
          <h2 id={`${id}-title`}>Report a problem without sharing your workspace</h2>
          <p>Build a redacted local report, review every field, then download it or hand it to a connected subscription CLI.</p>
        </div>
        {onClose && <button className="ensync-support__close" type="button" onClick={onClose} aria-label="Close support desk"><X size={19} /></button>}
      </header>

      <div className="ensync-support__availability" aria-label="Current support availability">
        <div>
          <small>Local reports</small>
          <strong className="is-available"><CheckCircle2 size={15} /> Available</strong>
          <span>Preview and download on this computer.</span>
        </div>
        <div>
          <small>Human help desk</small>
          <strong><AlertCircle size={15} /> Not configured</strong>
          <span>{availability?.humanHelpDesk.reason ?? 'Checking Ensync Host…'}</span>
        </div>
        <div>
          <small>Response SLA</small>
          <strong>None promised</strong>
          <span>No agent, queue position, or response time is simulated.</span>
        </div>
        <div>
          <small>GitHub issues</small>
          <strong className={githubAvailable ? 'is-available' : ''}>{githubAvailable ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}{githubAvailable ? 'Draft available' : 'Not configured'}</strong>
          <span>{availability?.githubIssues.reason ?? 'Checking Ensync Host…'}</span>
        </div>
      </div>

      <div className="ensync-support__layout">
        <form className="ensync-support__form" onSubmit={(event) => void createPreview(event)}>
          <div className="ensync-support__section-heading">
            <TicketCheck size={18} aria-hidden="true" />
            <div><strong>New local ticket</strong><span>Ticket status is stored only in this browser.</span></div>
          </div>

          <div className="ensync-support__fields">
            <label>
              <span>Category</span>
              <select value={category} onChange={(event) => { setCategory(event.target.value as SupportCategory); invalidatePreview() }}>
                {CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>
              <span>Short summary</span>
              <input
                value={summary}
                maxLength={160}
                onChange={(event) => { setSummary(event.target.value); invalidatePreview() }}
                placeholder="What stopped working?"
                autoComplete="off"
              />
            </label>
            <label>
              <span>What happened?</span>
              <textarea
                value={description}
                maxLength={20_000}
                rows={6}
                onChange={(event) => { setDescription(event.target.value); invalidatePreview() }}
                placeholder="Include steps to reproduce, what you expected, and what happened instead."
              />
              <small>Do not paste passwords, access tokens, recovery codes, private keys, or private file contents. This user-provided text is included exactly as written.</small>
            </label>
            <label className="ensync-support__check">
              <input
                type="checkbox"
                checked={includeProjectContext}
                onChange={(event) => { setIncludeProjectContext(event.target.checked); invalidatePreview() }}
              />
              <span><strong>Include redacted project structure facts</strong><small>Project ID/name, context-file counts, and adapter names only. No path, filenames, source code, or file contents.</small></span>
            </label>
          </div>

          <div className="ensync-support__privacy">
            <ShieldCheck size={17} aria-hidden="true" />
            <span><strong>Excluded automatically</strong><small>Chat text, secrets, source/file contents, absolute paths, environment variables, and command output.</small></span>
          </div>

          <button className="ensync-support__primary" type="submit" disabled={!summary.trim() || !description.trim() || busy !== null}>
            {busy === 'preview' ? <><LoaderCircle className="spin" size={16} /> Building preview…</> : <><FileJson size={16} /> Build private report</>}
          </button>
        </form>

        <aside className="ensync-support__tickets">
          <div className="ensync-support__section-heading">
            <LifeBuoy size={18} aria-hidden="true" />
            <div><strong>Tickets on this device</strong><span>Local tracking, not a staffed queue.</span></div>
          </div>
          {tickets.length === 0 ? (
            <p className="ensync-support__empty">No local support tickets yet.</p>
          ) : (
            <ul>
              {tickets.map((ticket) => (
                <li key={ticket.id}>
                  <span>{CATEGORIES.find((item) => item.id === ticket.category)?.label ?? ticket.category}</span>
                  <strong>{ticket.summary}</strong>
                  <small>{STATUS_LABELS[ticket.status]} · {new Date(ticket.updatedAt).toLocaleString()}</small>
                  {ticket.status !== 'resolved_locally' && (
                    <button type="button" onClick={() => updateTicketStatus(ticket.id, 'resolved_locally')}><Check size={13} /> Mark resolved locally</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      {report && (
        <section className="ensync-support__review" aria-labelledby={`${id}-review-title`}>
          <div className="ensync-support__section-heading">
            <FileJson size={18} aria-hidden="true" />
            <div><strong id={`${id}-review-title`}>Review the exact report</strong><span>No download, AI task, or GitHub draft is enabled until you confirm.</span></div>
          </div>
          <details open>
            <summary>JSON report · {report.ticket.id}</summary>
            <pre>{JSON.stringify(report, null, 2)}</pre>
          </details>
          <label className="ensync-support__check ensync-support__review-check">
            <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
            <span><strong>I reviewed the report above</strong><small>I understand that opening a GitHub draft shares this reviewed text with GitHub. Download and AI repair stay local to the configured app/runtime.</small></span>
          </label>
          {repairAvailable && (
            <label className="ensync-support__check ensync-support__repair-consent">
              <input type="checkbox" checked={repairConsent} onChange={(event) => setRepairConsent(event.target.checked)} />
              <span><strong>Allow {aiRepair.providerName ?? 'the selected subscription CLI'} to edit the focused project for this repair</strong><small>The repair route cannot commit, push, deploy, publish, mutate external tickets, or retry/fail over automatically. You must review its changes.</small></span>
            </label>
          )}
          <div className="ensync-support__actions">
            <button type="button" onClick={download} disabled={!reviewed || busy !== null}><Download size={16} /> Download JSON</button>
            <button type="button" onClick={() => void startAiRepair()} disabled={!reviewed || !repairConsent || !repairAvailable || busy !== null} title={repairAvailable ? undefined : aiRepair.reason}>
              {busy === 'ai' ? <LoaderCircle className="spin" size={16} /> : <Bot size={16} />}
              Fix with {aiRepair.providerName ?? 'my subscription'}
            </button>
            <button type="button" onClick={() => void openGitHubDraft()} disabled={!reviewed || !githubAvailable || busy !== null} title={githubAvailable ? undefined : availability?.githubIssues.reason}>
              {busy === 'github' ? <LoaderCircle className="spin" size={16} /> : <ExternalLink size={16} />}
              Open unsent GitHub draft
            </button>
          </div>
          {!repairAvailable && <p className="ensync-support__action-note"><Bot size={14} /> {aiRepair.reason}</p>}
          {repairResult && <div className="ensync-support__repair-result"><strong>Subscription CLI result · review required</strong><p>{repairResult}</p></div>}
        </section>
      )}

      {notice && <div className="ensync-support__notice ensync-support__notice--success" role="status"><CheckCircle2 size={17} /><span>{notice}</span></div>}
      {error && <div className="ensync-support__notice ensync-support__notice--error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
    </section>
  )
}

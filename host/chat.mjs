import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative } from 'node:path'
import { autoLandWorkspace } from './auto-land.mjs'
import { configuredHardTimeoutMs, describeProcessExit, runProcess, subscriptionEnvironment } from './command.mjs'
import { runLandCheck } from './land-check.mjs'
import { CodexLiveTurnError, CodexLiveTurnRunner } from './codex-live-turn.mjs'
import { DroidExecError, DroidExecRunner, DROID_AUTONOMY_LEVEL } from './droid-exec.mjs'
import { CodebuddyExecError, CodebuddyExecRunner, CODEBUDDY_PERMISSION_MODE } from './codebuddy-exec.mjs'
import { CursorAgentError, CursorAgentRunner, CURSOR_SANDBOX_MODE } from './cursor-agent.mjs'
import { KIMI_FORCED_PERMISSION_MODE, KIMI_PROMPT_TRANSPORT } from './kimi-exec.mjs'
import { JUNIE_CONFIG_DEFAULT_LOCATIONS } from './junie-exec.mjs'
import { AUGGIE_DENIED_TOOLS, AUGGIE_PROMPT_TRANSPORT } from './auggie-exec.mjs'
import { claudeQuestionArguments, claudeUserMessageLine, createClaudeQuestionChannel } from './claude-questions.mjs'
import { ProviderQuestionError } from './provider-questions.mjs'
import { finalCodexResponse } from './codex-response.mjs'
import { decodeJsonEventStream } from './json-event-repair.mjs'
import {
  withoutLeadingEnsyncMultiAgentInstructions,
  withEnsyncMultiAgentInstructions,
} from './multi-agent-prompt.mjs'

const SUPPORTED_CHAT_PROVIDERS = new Set(['codex', 'claude', 'droid', 'cursor'])
// Providers whose Ensync Host runner is implemented and containment-recorded but
// whose catalog entry is still `discovery_only`. They are refused at validation
// with their exact outstanding requirement instead of a generic message, so the
// runner cannot be reached by Auto routing, a fixed selection, or fallback until
// the catalog is promoted.
const GATED_CHAT_PROVIDERS = new Map([
  // GitHub Copilot CLI 1.0.79 maps cleanly onto every Ensync requirement except
  // prompt delivery: its only non-interactive prompt input is `-p/--prompt <text>`,
  // which puts the prompt in argv, and Ensync never does that. Its
  // `--output-format json` stream is documented as "JSONL, one JSON object per
  // line" but the CLI ships as a compiled single-file binary with no readable
  // schema, so the exact terminal object that would prove a completed turn could
  // not be verified without spending a real model turn. Both gaps are recorded in
  // docs/providers/copilot.md; `copilot --acp` (Agent Client Protocol over stdio)
  // is the candidate that would carry the prompt off argv.
  ['copilot', 'Its only verified non-interactive prompt input is the --prompt argument, and Ensync never puts a prompt in argv. Ensync also has no verified terminal event from its JSON output stream, so it cannot confirm a run finished.'],
  // CodeBuddy Code 2.133.1 maps onto every Ensync requirement and its runner is
  // implemented in codebuddy-exec.mjs: prompt on stdin (verified by an EOF-wait
  // timing test, no prompt content sent), a stream-json `result` terminal event,
  // and — unusually — a `system.init` event that echoes the effective
  // permissionMode and cwd back, which the runner checks before releasing the
  // prompt. What is missing is evidence: the CLI is not signed in on this machine
  // (`codebuddy help config` answers "Authentication required"; no Keychain item;
  // numStartups is 0), so no authenticated turn has ever been observed. The
  // headless approval question — deny, or block forever the way droid used to —
  // is therefore unverified, and it is the exact defect that gating exists to
  // prevent. See docs/providers/codebuddy.md.
  ['codebuddy', 'Ensync has a complete CodeBuddy runner, but CodeBuddy is not signed in on this machine, so no authenticated turn has ever been verified. Until one is, Ensync cannot confirm that a permission request in a headless run is denied rather than left waiting forever. Sign in to CodeBuddy Code, then re-verify.'],
  // Ollama is a local inference server, not a coding agent. Verified against
  // 0.13.5: it cannot read or write files, run commands, hold a session, or
  // constrain a working directory, because it has no tool-execution layer at all
  // (`/api/chat` can emit tool-call JSON, but the CALLER must execute it). There
  // is no containment record for it below, and that is deliberate — the question
  // does not apply rather than being unanswered. Every Ensync prompt is wrapped
  // in instructions to edit files and coordinate work, so a runtime that cannot
  // act would report edits it never made. See docs/providers/ollama.md.
  ['ollama', 'Ollama is a local model runtime, not a coding agent: it cannot read or write files, run commands, or hold a session, so it cannot carry out an Ensync task. Ensync uses it for local model discovery only. Use Codex, Claude Code, or Factory Droid to run work.'],
  // Jules v0.1.42 is a thin client for a Google-hosted asynchronous agent, not a local
  // CLI. `jules new` assigns a session to a Google VM working on a GitHub repository and
  // returns once the session is ASSIGNED, not finished; results are collected later with
  // `jules remote pull` or `jules teleport`. No subcommand has a JSON/stream flag, so
  // there is no terminal event at all, and the protected worktree contains nothing the
  // agent runs in. No runner module exists because Step 1 found nothing runnable under
  // Ensync's contract. See docs/providers/jules.md.
  ['jules', 'Jules runs its work in a Google-hosted VM against a GitHub repository rather than in this project’s protected worktree, and its CLI has no machine-readable output, so Ensync can neither contain the work nor confirm a run finished. Use Codex, Claude Code, or Factory Droid to run work.'],
  // Kimi Code 0.34.0 has a complete runner in kimi-exec.mjs — verified argument
  // construction, NDJSON parsing, and the `session.resume_hint` terminal frame — and it
  // cannot hang on an approval, because prompt mode pins permission mode `auto` itself.
  // Two independent gaps block promotion, both recorded in docs/providers/kimi.md.
  ['kimi', 'Its only non-interactive prompt input is the --prompt argument, and Ensync never puts a prompt in argv. Its one-shot mode also pins its own fully autonomous permission mode, and the deny rules that could outrank it can only be read from the user-global config.toml, so Ensync cannot contain a single run without rewriting your global Kimi settings.'],
  // Junie 26.8.3 has a complete runner in junie-exec.mjs and is the strongest candidate
  // of the three: prompt on stdin, a single terminal CliOutput object with real token
  // usage, model and effort flags, and a genuinely path-scoped allowlist defined
  // relative to the project root. It is gated on the one question that cannot be
  // answered without spending a real model turn — whether a headless run denies an
  // approval request or waits on it forever, which is the exact defect that made droid
  // hang on "Working". See docs/providers/junie.md.
  ['junie', 'Its --brave approval control is documented as interactive-only, and its headless event stream still defines approval-request events, so Ensync cannot yet confirm that an approval in a headless run is denied rather than left waiting forever. Its allowlist also lives at a single user-global path with no per-run override.'],
  // Auggie 0.34.0 has a complete runner in auggie-exec.mjs. Everything Ensync needs was
  // verified by reading the CLI's own shipped ESM bundle (it is minified but not
  // obfuscated): the prompt on stdin in `--print` mode, the single terminal
  // `{"type":"result",...}` object, the `--permission tool:policy` engine, and — the
  // droid question — the fact that a `--print` run installs NO approval handler, so an
  // unapprovable tool is denied with an error tool-result and the loop continues rather
  // than blocking. What is missing is evidence: the CLI is not signed in on this machine
  // (`auggie account status` answers "You are not currently logged in to Augment"; there
  // is no ~/.augment/session.json), so no authenticated turn has ever been observed and
  // none of that reading has been watched actually happening. See docs/providers/auggie.md.
  ['auggie', 'Ensync has a complete Auggie runner, but Auggie is not signed in on this machine, so no authenticated turn has ever been verified. Until one is, Ensync cannot confirm that a denied tool in a headless run really is refused and reported rather than left waiting forever. Sign in with auggie login, then re-verify.'],
  // Warp Oz 0.2026.07.29.09.05 fails three independent Ensync requirements at once, so no
  // runner module exists — writing one would mean inventing protocol Ensync has not seen.
  // See docs/providers/oz.md.
  ['oz', 'Its only non-interactive prompt inputs are the --prompt argument and server-stored prompt IDs, and Ensync never puts a prompt in argv. Its ndjson event union is also unpublished, so Ensync has no terminal event to confirm a run finished, and its agent permissions live in Warp-synced execution profiles that no CLI flag can pin for a single run.'],
  // Amp 0.0.1786006377 is the strongest candidate on paper — a documented stdin prompt in
  // `-x/--execute`, a Claude-Code-compatible `--stream-json` mode, and a per-run
  // `--settings-file` override — but not one of those claims could be observed here: the
  // binary produces no output at all, and it is not signed in. Its own log proves an
  // unauthenticated invocation opens a browser and blocks for five minutes before failing,
  // which is strictly worse than a hang. See docs/providers/amp.md.
  ['amp', 'The Amp binary produces no output at all on this machine — even amp --version blocks indefinitely — so Ensync has verified none of its behaviour. Amp is also not signed in, and its own log shows an unauthenticated run opening a browser login and blocking for five minutes before failing. Sign in to Amp and get amp --version to answer, then re-verify.'],
])
// Verified containment levels per the catalog capability contract. A provider
// with no record here is refused as runnable regardless of SUPPORTED_CHAT_PROVIDERS.
const CHAT_PROVIDER_CONTAINMENT = {
  codex: { level: 'os_sandbox' },
  // permission_config gap (verified via `claude --help`): in `-p`/`--print` mode, settings
  // files that fail validation are silently ignored (no error dialog is shown) — a malformed
  // --settings payload fails open rather than blocking the run. Also, Bash is governed by
  // command-prefix rules, not the file-pattern rules our deny list uses, so Write(...)/Edit(...)
  // deny rules do not constrain shell commands run through the Bash tool.
  claude: { level: 'permission_config' },
  // permission_config gap (verified against droid 0.190.0 over stream-jsonrpc):
  // Droid's containment is a risk-tiered autonomy level pinned per session, not a
  // path-scoped rule, so `medium` still permits ordinary local build, test, and git
  // operations anywhere the process can reach rather than confining writes to the
  // protected worktree. Its session settings schema also declares autonomyLevel as
  // `.optional().catch(void 0)`, so an unrecognised value is silently discarded
  // instead of rejected; the runner therefore refuses to send the prompt unless the
  // CLI echoes the pinned level back in its effective settings.
  droid: { level: 'permission_config', autonomyLevel: DROID_AUTONOMY_LEVEL },
  // os_sandbox gap (verified against cursor-agent 2026.08.04-aaa8809 by reading
  // its bundled sources, not by observing a live run): headless approval is
  // all-or-nothing. The CLI picks an always-approve or an always-deny decision
  // provider from `isHeadless ? (headlessAutoApprove ? AlwaysApprove : AlwaysDeny)`,
  // and the persisted `permissions.deny` list is never consulted on that path.
  // An always-deny run cannot edit a file or run a command, so a useful run has to
  // pin the run-everything mode, which leaves NO permission-layer containment.
  // Containment is therefore the OS sandbox alone: `--sandbox enabled` overrides
  // both the persisted mode and the server default, is applied to the executor
  // independently of the decision provider, and — the part Ensync relies on — a
  // headless run exits non-zero rather than running unsandboxed when the host
  // cannot support it. The runner maps that exit to provider_containment_unverified.
  cursor: { level: 'os_sandbox', sandboxMode: CURSOR_SANDBOX_MODE },
  // permission_config gap (verified against codebuddy 2.133.1 by running the
  // headless stream with an EMPTY prompt, which the CLI bills as
  // duration_api_ms 0 / total_cost_usd 0 — no model turn was spent):
  //   * `--permission-mode` fails open. `--permission-mode __bogus__` is silently
  //     discarded and the session reports "default", with no error and exit 0 —
  //     the same trap as droid's `.optional().catch(void 0)` autonomy field.
  //     Mitigated because `system.init` echoes the EFFECTIVE permissionMode and
  //     cwd, so the runner withholds the prompt until the echo matches.
  //   * `--settings` also fails open: a malformed payload (`'{{{not json'`) is
  //     ignored with no error, so the deny rules are not self-proving. Same gap
  //     already recorded for Claude Code.
  //   * Deny rules are rule-engine entries evaluated by the agent process itself,
  //     not an OS boundary, and shell tools are matched by command prefix rather
  //     than the file globs used here — so Write(...)/Edit(...) rules do not
  //     constrain commands run through a shell tool.
  //   * No authenticated turn has ever been observed on this machine, so none of
  //     the above has been watched actually blocking a write. This provider stays
  //     in GATED_CHAT_PROVIDERS for exactly that reason.
  codebuddy: { level: 'permission_config', permissionMode: CODEBUDDY_PERMISSION_MODE },
  // cwd_only, and deliberately not permission_config (verified against Kimi Code 0.34.0
  // by reading the CLI's own bundled JavaScript, which ships in plaintext inside the
  // binary — no model turn was spent):
  //   * Prompt mode pins the permission mode ITSELF, and Ensync does not get a say:
  //     resolveNativeSession calls setMode("auto") for a fresh session and forceAuto()
  //     for --session/--continue, regardless of -y/--yolo or --auto.
  //   * AutoModeApprovePermissionPolicy is then literally
  //     `if (mode !== "auto") return; return { kind: "approve" }` — every tool call.
  //     The upside is that it cannot hang: AutoModeAskUserQuestionDeny denies the
  //     AskUserQuestion tool outright while auto mode is active.
  //   * Configured DENY rules do outrank it, because UserConfiguredDeny runs before
  //     AutoModeApprove in createPermissionDecisionPolicies. But they can only be read
  //     from the user-global config.toml under KIMI_CODE_HOME: the project-local file
  //     <root>/.kimi-code/local.toml has schema `{workspace:{additional_dir:string[]}}`
  //     and accepts nothing else, and no CLI flag installs a rule. Ensync will not
  //     rewrite a user's global settings to contain one run, and pointing
  //     KIMI_CODE_HOME elsewhere would also relocate credentials/ and very likely break
  //     the stored subscription login.
  //   * SensitiveFileAccessAsk and GitControlPathAccessAsk sit AFTER AutoModeApprove in
  //     the chain, so Kimi's own built-in protections never fire in this mode.
  // cwd is therefore the entire enforcement surface, which is why kimi stays gated.
  kimi: { level: 'cwd_only', permissionMode: KIMI_FORCED_PERMISSION_MODE, promptTransport: KIMI_PROMPT_TRANSPORT },
  // cwd_only, and deliberately not permission_config (verified against Junie 26.8.3
  // from `junie --help`, the docs JetBrains ships inside the release jar, and constant
  // strings extracted from that jar — no model turn was spent):
  //   * Junie DOES have real path-scoped containment: ~/.junie/allowlist.json carries
  //     `defaultBehavior`, `allowReadonlyCommands`, and prefix/glob rules across
  //     fileEditing, executables, mcpTools, and readOutsideProject, with fileEditing
  //     paths resolved RELATIVE TO THE PROJECT ROOT. That is stronger than droid's
  //     risk-tier autonomy level.
  //   * But that file has one fixed user-global location and no per-run override. The
  //     documented config.json field list — which --config-location can point at — has
  //     no allowlist field, so Ensync cannot scope a single run without rewriting a
  //     user-global file.
  //   * `--brave` is documented "(interactive only)", so no argv flag pins approval
  //     behaviour headlessly, while the headless event union still defines
  //     ApprovableBlockUpdated, AskRequestUpdated, AskAsyncRequestUpdated,
  //     ChoiceRequestUpdated, and GoalPlanApprovalRequestUpdated events. Whether a
  //     headless run denies one or waits on it forever could only be settled by
  //     spending a real model turn, so it is recorded as unknown, not assumed.
  //   * Mitigation the runner does apply: headless launches are "always trusted" per
  //     JetBrains' own docs and would otherwise load project-supplied config, MCP
  //     servers, and skills out of the worktree, so every run passes
  //     --config-default-locations=false.
  junie: { level: 'cwd_only', configDefaultLocations: JUNIE_CONFIG_DEFAULT_LOCATIONS },
  // permission_config gap (verified against Auggie 0.34.0 by reading the CLI's own
  // shipped ESM bundle at @augmentcode/auggie/augment.mjs — no instruction was sent to a
  // model):
  //   * The default with NO rules is ALLOW EVERYTHING. `b2e` opens with
  //     `if (o.length === 0) return { allow: true }`, so an unpinned Auggie run has no
  //     containment whatsoever. The runner therefore always sends explicit deny rules.
  //   * `--permission` FAILS OPEN. Its argParser `AYo` catches a parse error, emits
  //     `WARNING: Failed to parse permission rule "..."`, and returns the rule list
  //     UNCHANGED — the run proceeds with weaker permissions rather than refusing to
  //     start. There is no echo of the effective permission set (unlike CodeBuddy's
  //     system.init), so that warning line is the only available signal; the runner
  //     scans both streams for it and fails the run as provider_containment_unverified.
  //   * Rules match on the EXACT tool name only. The one content-aware field,
  //     shellInputRegex, exists solely in the settings.json rule schema, so from argv a
  //     shell can be denied entirely or allowed entirely — nothing in between. Ensync
  //     denies the five process tools and web-fetch outright for that reason.
  //   * Nothing is path-scoped. `--workspace-root` bounds what Auggie INDEXES, not what
  //     it may write, and denials are enforced by the agent process returning an error
  //     tool-result to the model rather than by any OS boundary.
  //   * No authenticated turn has ever been observed on this machine, so none of the
  //     above has been watched actually blocking a write. This provider stays in
  //     GATED_CHAT_PROVIDERS for exactly that reason.
  auggie: {
    level: 'permission_config',
    deniedTools: AUGGIE_DENIED_TOOLS,
    promptTransport: AUGGIE_PROMPT_TRANSPORT,
  },
  // Deliberately NO oz record: Warp Oz expresses agent permissions only as execution
  // profiles authored in the Warp GUI/TUI and synced through Warp Cloud, and no
  // `oz agent run` flag pins one for a single run (`oz agent profile` can only `list`).
  // There is no level Ensync could honestly claim, so the absent record keeps it
  // unrunnable — the same treatment as ollama and jules.
  // Deliberately NO amp record either: the Amp binary produces no output at all on this
  // machine, so its containment surface (`--settings-file` plus an `amp.permissions`
  // block whose schema was never read) is entirely unverified. Claiming a level from an
  // unverifiable binary would be a guess.
  // Deliberately NO ollama record: it is an inference server with no tool
  // execution, so there is nothing to contain and no containment level that
  // could honestly be claimed. The absent record keeps it unrunnable.
  // Deliberately NO jules record either, for the same shape of reason: its work runs in
  // a Google-hosted VM against a GitHub repository, so there is no local process to
  // contain and no honest level to claim. The absent record keeps it unrunnable.
}
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
// A question card holds the inactivity watchdog for as long as a person needs
// to read it, but never longer than this: an unanswered question also pins this
// conversation's workspace lease, so every other message in the same chat waits
// behind it. One hour is far past a real answer and far short of a lost evening.
const DEFAULT_QUESTION_HOLD_TIMEOUT_MS = 60 * 60 * 1_000
// There is no absolute run ceiling by default; this conservative ceiling is
// applied only when ENSYNC_CHAT_HARD_TIMEOUT_MS is present but unverifiable.
const INVALID_HARD_TIMEOUT_FALLBACK_MS = 24 * 60 * 60 * 1_000
const MAX_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_PROMPT_LENGTH = 100_000
const MAX_CHAT_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_ATTACHMENT_COUNT = 64
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/
const MODEL_EFFORTS = new Set(['low', 'medium', 'high', 'max'])
const CODEX_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp'])
const QUOTA_PATTERN = /(?:usage|spending|rate)[\s_-]*limit|quota|capacity|overloaded|too many requests|out of credits|insufficient credits|credit balance/i
const TERMINAL_EVENT_TEXT_LIMIT = 256 * 1024
const CLAUDE_PENDING_NOTE_MESSAGES = 8
const SECRET_PATTERNS = [
  /\b(?:sk-(?:proj-|live-)?|ghp_|github_pat_|glpat-|xox[baprs]-)[a-zA-Z0-9_-]{12,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._~+\/-]{12,}/gi,
  /\b[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/g,
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|authorization)\b(\s*[:=]\s*["']?)([^\s"',}]{8,})/gi,
]

// A Map keeps a request-supplied provider string from resolving to an inherited
// Object property before the allowlist check runs.
const PROVIDER_LABELS = new Map([
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['droid', 'Factory Droid'],
  ['cursor', 'Cursor Agent'],
  ['copilot', 'GitHub Copilot CLI'],
  ['codebuddy', 'CodeBuddy Code'],
  ['ollama', 'Ollama'],
  ['jules', 'Jules'],
  ['kimi', 'Kimi Code'],
  ['junie', 'Junie'],
  ['auggie', 'Augment Auggie'],
  ['oz', 'Warp Oz'],
  ['amp', 'Amp'],
])

function providerLabel(providerId) {
  return PROVIDER_LABELS.get(providerId) ?? providerId
}

export class ChatRunError extends Error {
  constructor(code, message, status = 400, safeToRetry = false) {
    super(message)
    this.name = 'ChatRunError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

function cancelledRunError() {
  return new ChatRunError(
    'run_cancelled',
    'Run stopped by user. The provider process was terminated.',
    499,
    false,
  )
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledRunError()
}

function combinedAbortSignal(...signals) {
  const active = signals.filter(Boolean)
  if (active.length === 0) return { signal: undefined, dispose() {} }
  if (active.length === 1) return { signal: active[0], dispose() {} }
  const controller = new AbortController()
  const abort = (event) => controller.abort(event?.target?.reason)
  for (const signal of active) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', abort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of active) signal.removeEventListener('abort', abort)
    },
  }
}

export function workspaceBaseSummary(workspace) {
  const base = workspace?.base
  if (!base) return null
  const canonical = base.remote && base.branch ? `${base.remote}/${base.branch}` : 'the canonical branch'
  if (base.source === 'remote_default_branch') {
    return `Base: ${canonical} at ${base.sha}${base.refreshed ? ', fetched for this run' : ''}.`
  }
  if (base.source === 'already_canonical') return `Base: already current with ${canonical} at ${base.sha}.`
  if (base.reason) return `Base: ${base.sha}. ${base.reason}`
  return `Base: ${base.sha}.`
}

export function workspaceOverlapPrompt(overlaps) {
  if (!Array.isArray(overlaps) || overlaps.length === 0) return ''
  const paths = [...new Set(overlaps.flatMap((overlap) => Array.isArray(overlap?.paths) ? overlap.paths : []))]
    .filter((path) => typeof path === 'string' && path.length > 0)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 20)
  if (paths.length === 0) return ''
  return `[ENSYNC HOST CROSS-CONVERSATION FILE AWARENESS]
Another Ensync conversation is actively editing or has unlanded changes in files this branch also changes:
${paths.map((path) => `- ${path}`).join('\n')}
Before changing these paths, re-read their current contents and preserve compatible work. Do not access another checkout or worktree, and do not push or land; Ensync Host rechecks and lands this branch.
`
}

function boundedBaselineConflict(workspace) {
  const conflict = workspace?.baselineConflict
  if (!conflict || !/^[0-9a-f]{40,64}$/i.test(conflict.baselineSha ?? '')) return null
  const files = Array.isArray(conflict.files)
    ? [...new Set(conflict.files.filter((file) => (
      typeof file === 'string'
      && file.length > 0
      && file.length <= 1_024
      && !/[\u0000-\u001f\u007f]/.test(file)
    )))].slice(0, 50)
    : []
  const reason = typeof conflict.reason === 'string'
    && conflict.reason.length <= 1_024
    && !/[\u0000-\u001f\u007f]/.test(conflict.reason)
    ? conflict.reason
    : 'New baseline changes conflict with this conversation’s work. Ensync preserved the clean conversation branch and will reconcile it before landing.'
  return { baselineSha: conflict.baselineSha, files, reason }
}

function deferredBaselinePrompt(workspace) {
  const conflict = boundedBaselineConflict(workspace)
  if (!conflict) return ''
  const { files } = conflict
  return `[ENSYNC HOST DEFERRED BASELINE RECONCILIATION]
Baseline commit ${conflict.baselineSha} conflicts with this conversation's committed work${files.length > 0 ? ' in:' : '.'}
${files.map((file) => `- ${file}`).join('\n')}
Ensync aborted the failed merge and verified that this exact conversation branch is clean. Continue the user's requested work in the current worktree, re-read these files before editing them, and preserve compatible existing changes. Do not access another checkout or try to merge the baseline now; Ensync will reconcile this branch before landing.
`
}

function overlapUnavailableNotice(error) {
  return {
    type: 'notice',
    code: 'workspace_overlap_unavailable',
    message: `Ensync could not refresh cross-conversation file awareness: ${error instanceof Error ? error.message : 'unknown error'}. Protected workspace isolation remains active.`,
    at: new Date().toISOString(),
  }
}

async function refreshOverlapSession(session, onEvent) {
  if (!session) return []
  try {
    return await session.refresh()
  } catch (error) {
    onEvent?.(overlapUnavailableNotice(error))
    try {
      return session.current()
    } catch {
      return []
    }
  }
}

async function stopOverlapSession(session, onEvent) {
  if (!session) return
  try {
    await session.stop()
  } catch (error) {
    onEvent?.(overlapUnavailableNotice(error))
  }
}

function isolatedPrompt(prompt, workspace, overlaps = []) {
  if (!workspace) return prompt
  const base = workspaceBaseSummary(workspace)
  const unintegrated = Number.isInteger(workspace.integration?.unintegratedCommits)
    && workspace.integration.unintegratedCommits > 0
    && !boundedBaselineConflict(workspace)
    ? `This branch has ${workspace.integration.unintegratedCommits} commit(s) that the canonical branch does not contain yet. Ensync never merges them for you.\n`
    : ''
  return `[ENSYNC HOST WORKSPACE ISOLATION]
This run is bound to the protected Git worktree that is the current working directory.
Treat the current working directory as the only writable project for this task. Do not access or modify another checkout or worktree of the same repository, even if earlier conversation context names a canonical project path.
Ensync Host commits this branch when the run ends and performs the push and land itself, so \`git push\` is not part of your task. An approval request that nobody is there to answer is declined, and a declined request can end your run before you report back. Finish by reporting what you changed.
Protected branch: ${workspace.branch}
Verified worktree state before this run: ${workspace.gitBefore.dirty ? `${workspace.gitBefore.changedFiles} changed files` : 'clean'} at ${workspace.gitBefore.head}.
  ${base ? `${base}\n` : ''}${deferredBaselinePrompt(workspace)}${unintegrated}${workspaceOverlapPrompt(overlaps)}
  ${prompt}`
}

function conflictResolutionPrompt({ branch, baselineSha, conflictFiles, overlaps = [] }) {
  return `[ENSYNC HOST CONFLICT RESOLUTION]
Ensync merged baseline commit ${baselineSha} into this conversation's protected branch ${branch} so the finished work can land, and the merge stopped with conflicts. The merge is still in progress in the current working directory (MERGE_HEAD exists). Your only task is to finish it:
1. Inspect the conflicts with \`git status\` and \`git diff\`.
2. Edit each conflicted file so the baseline changes and this branch's changes are both preserved, and remove every conflict marker. Only drop one side when the two changes are truly incompatible; prefer the baseline's intent for changes this conversation did not make.
3. Stage each resolved file with \`git add\`.
4. Conclude the merge with \`git commit --no-verify --no-edit\`.
Do not push, do not modify any other checkout or worktree, do not rebase or amend existing commits, and do not start unrelated work.
Conflicted files:
  ${conflictFiles.map((file) => `- ${file}`).join('\n')}
  ${workspaceOverlapPrompt(overlaps)}`
}

function landCheckRepairPrompt({ branch, baselineSha, reason, output, overlaps = [] }) {
  return `[ENSYNC HOST LAND CHECK REPAIR]
Ensync merged this conversation's branch ${branch} into the baseline and ran the repository's land check (npm run land:check). The check failed, so the merge was rolled back. Baseline commit ${baselineSha} is already merged into the protected worktree that is the current working directory. Your only task is to make the land check pass here:
1. Reproduce the failure if possible (npm run land:check) or work from the failure output below.
2. This failure usually means the merge silently dropped code one side depends on — for example a declaration or import whose usages survived. Compare this branch with the baseline (git log, git show, git diff) and restore the missing code. Do not delete working features just to silence the check.
3. Commit the fix with git add and git commit --no-verify.
Do not push, do not modify any other checkout or worktree, do not rebase or amend existing commits, and do not start unrelated work.
  Failure: ${reason}${output ? `\nCheck output:\n${output}` : ''}
  ${workspaceOverlapPrompt(overlaps)}`
}

function timeoutMessage(providerName, timeoutReason) {
  if (timeoutReason === 'inactivity') {
    return `${providerName} produced no CLI output or lifecycle progress before Ensync Host's inactivity limit and was stopped. Partial work may exist; review the project before retrying.`
  }
  if (timeoutReason === 'hard_limit') {
    return `${providerName} reached Ensync Host's hard run limit and was stopped. Partial work may exist; review the project before retrying.`
  }
  if (timeoutReason === 'question_unanswered') {
    return `${providerName} waited for an answer to its question longer than Ensync Host allows one run to hold this conversation's workspace, and was stopped. Nothing was answered on your behalf. Partial work is saved to this conversation's branch; send the answer as a message to continue.`
  }
  return `${providerName} reached an Ensync Host run limit and was stopped. Partial work may exist; review the project before retrying.`
}

export function redactTerminalText(value) {
  let text = typeof value === 'string' ? value : String(value ?? '')
  let redacted = false
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...parts) => {
      redacted = true
      if (parts.length > 4 && typeof parts[1] === 'string' && typeof parts[2] === 'string') {
        return `${parts[1]}${parts[2]}[REDACTED]`
      }
      return '[REDACTED]'
    })
  }
  if (text.length > TERMINAL_EVENT_TEXT_LIMIT) {
    text = `${text.slice(0, TERMINAL_EVENT_TEXT_LIMIT)}\n[OUTPUT TRUNCATED BY ENSYNC HOST]`
    redacted = true
  }
  return { text, redacted }
}

function quoteTerminalArgument(argument) {
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(argument)) return argument
  return `'${argument.replaceAll("'", "'\\''")}'`
}

function visibleArguments(request, attachmentPaths, containment = null, options = {}) {
  const imagePaths = new Set(codexImagePaths(attachmentPaths))
  return argumentsFor(request, attachmentPaths, containment, options).map((argument, index, argumentsList) => {
    if (request.sessionId && argument === request.sessionId) return '<session-id>'
    if (index > 0 && argumentsList[index - 1] === '--resume') return '<session-id>'
    if (imagePaths.has(argument)) return '<attached-image>'
    return argument
  })
}

function assistantTextBlocks(content) {
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

function claudeNoteExtractor() {
  const pending = new Map()

  const remember = (id, text) => {
    const held = pending.get(id) ?? { text: '', toolStarted: false }
    if (text) held.text = held.text ? `${held.text}\n\n${text}` : text
    if (held.text.length > TERMINAL_EVENT_TEXT_LIMIT) held.text = held.text.slice(0, TERMINAL_EVENT_TEXT_LIMIT)
    pending.set(id, held)
    while (pending.size > CLAUDE_PENDING_NOTE_MESSAGES) pending.delete(pending.keys().next().value)
    return held
  }

  return (event) => {
    if (event.type !== 'assistant') return null
    const content = event.message?.content ?? event.content
    if (!Array.isArray(content)) return null
    const text = assistantTextBlocks(content)
    const startsToolWork = content.some((block) => block && typeof block === 'object' && block.type === 'tool_use')
    const id = typeof event.message?.id === 'string' && event.message.id ? event.message.id : null
    if (!id) return startsToolWork ? text || null : null

    const held = remember(id, text)
    if (!startsToolWork && !held.toolStarted) return null
    held.toolStarted = true
    const note = held.text
    held.text = ''
    return note || null
  }
}

function providerNoteExtractor(provider) {
  if (provider === 'claude') return claudeNoteExtractor()
  return (event) => {
    if (
      provider === 'codex'
      && event.type === 'item.completed'
      && event.item?.type === 'agent_message'
      && event.item.phase === 'commentary'
      && typeof event.item.text === 'string'
      && event.item.text.trim()
    ) {
      return event.item.text.trim()
    }
    return null
  }
}

/**
 * Provider-authored text is redacted before it leaves the Host, including the
 * text of a question. A person's own answer is not: it is their words, echoed
 * back into the transcript exactly as a prompt would be.
 */
function redactedRunEvent(event) {
  if (event?.type === 'question') {
    return {
      ...event,
      questions: event.questions.map((question) => ({
        ...question,
        header: redactTerminalText(question.header).text,
        question: redactTerminalText(question.question).text,
        options: question.options.map((option) => ({
          label: redactTerminalText(option.label).text,
          description: option.description === null ? null : redactTerminalText(option.description).text,
          // The outcome value is not provider prose: it is an enum member the
          // Host itself matched against its own allow-list, and it is what the
          // answer names, so redacting it would break the approval.
          value: option.value ?? null,
        })),
      })),
    }
  }
  if (!['output', 'note'].includes(event?.type)) return event
  const safe = redactTerminalText(event.text)
  return { ...event, text: safe.text, redacted: safe.redacted }
}

function outputForwarder(onEvent, provider, { onStdoutLine } = {}) {
  if (typeof onEvent !== 'function' && typeof onStdoutLine !== 'function') {
    return { stdout() {}, stderr() {}, flush() {} }
  }
  const buffers = { stdout: '', stderr: '' }
  const noteFromEvent = providerNoteExtractor(provider)
  const emit = (stream, text) => {
    if (!text) return
    // The interactive channel sees every stdout line before it is redacted:
    // it answers protocol frames rather than displaying them.
    if (stream === 'stdout') onStdoutLine?.(text)
    if (typeof onEvent !== 'function') return
    const safe = redactTerminalText(text)
    onEvent({
      type: 'output',
      stream,
      text: safe.text,
      redacted: safe.redacted,
      at: new Date().toISOString(),
    })
    if (stream !== 'stdout') return
    let structured
    try {
      structured = JSON.parse(text)
    } catch {
      return
    }
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return
    const note = noteFromEvent(structured)
    if (!note) return
    const safeNote = redactTerminalText(note)
    onEvent({
      type: 'note',
      provider,
      text: safeNote.text,
      redacted: safeNote.redacted,
      at: new Date().toISOString(),
    })
  }
  const append = (stream, chunk) => {
    const lines = (buffers[stream] + chunk).split(/(?<=\n)/)
    // Only a line still missing its newline is held back. Retaining the last
    // *complete* line until the next chunk would strand the CLI's terminal
    // frame — the one that ends the stream, so no next chunk ever arrives.
    buffers[stream] = lines.at(-1).endsWith('\n') ? '' : lines.pop()
    for (const line of lines) emit(stream, line)
  }
  return {
    stdout: (chunk) => append('stdout', chunk),
    stderr: (chunk) => append('stderr', chunk),
    flush() {
      emit('stdout', buffers.stdout)
      emit('stderr', buffers.stderr)
      buffers.stdout = ''
      buffers.stderr = ''
    },
  }
}

function asChatRunError(error, code, fallbackMessage, status = 400) {
  if (error instanceof ChatRunError) return error
  return new ChatRunError(code, fallbackMessage, status)
}

function pathIsWithin(candidate, root) {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

export async function validateProjectPath(projectPath, options = {}) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new ChatRunError('invalid_project', 'Select a project folder before running a chat.')
  }
  if (!isAbsolute(projectPath)) {
    throw new ChatRunError('invalid_project', 'The project path must be an absolute path.')
  }

  let resolvedPath
  try {
    resolvedPath = await realpath(projectPath)
    const projectStat = await stat(resolvedPath)
    if (!projectStat.isDirectory()) {
      throw new ChatRunError('invalid_project', 'The selected project path is not a directory.')
    }
  } catch (error) {
    throw asChatRunError(
      error,
      'invalid_project',
      'The selected project folder does not exist or cannot be accessed.',
    )
  }

  if (dirname(resolvedPath) === resolvedPath) {
    throw new ChatRunError('invalid_project', 'A filesystem root cannot be used as an Ensync project.')
  }

  if (Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0) {
    const allowedRoots = await Promise.all(options.allowedRoots.map(async (root) => realpath(root)))
    if (!allowedRoots.some((root) => pathIsWithin(resolvedPath, root))) {
      throw new ChatRunError(
        'project_not_allowed',
        'The selected folder is outside the project roots allowed by this Ensync Host.',
        403,
      )
    }
  }

  return resolvedPath
}

export async function validateAttachmentPaths(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) {
    throw new ChatRunError(
      'invalid_attachments',
      `Attach no more than ${MAX_ATTACHMENT_COUNT} local files to one turn.`,
      413,
    )
  }

  const resolvedPaths = []
  const seen = new Set()
  for (const attachmentPath of value) {
    if (typeof attachmentPath !== 'string' || !attachmentPath.trim() || !isAbsolute(attachmentPath)) {
      throw new ChatRunError('invalid_attachment', 'Every attached file must have an absolute local path.')
    }
    let resolvedPath
    try {
      resolvedPath = await realpath(attachmentPath)
      const attachmentStat = await stat(resolvedPath)
      if (!attachmentStat.isFile()) {
        throw new ChatRunError('invalid_attachment', 'Only files can be attached to a chat turn.')
      }
    } catch (error) {
      throw asChatRunError(
        error,
        'invalid_attachment',
        'An attached file no longer exists or cannot be accessed.',
      )
    }
    // stat() alone passes on OS-protected files (macOS screenshot drag temp
    // dirs) that the agent CLI still cannot open, so probe with a real open.
    try {
      const handle = await open(resolvedPath, 'r')
      await handle.close()
    } catch {
      throw new ChatRunError(
        'unreadable_attachment',
        `The operating system prevents Ensync from opening "${basename(resolvedPath)}". Remove it from the message and re-attach it so Ensync can store a readable copy.`,
      )
    }
    if (!seen.has(resolvedPath)) {
      seen.add(resolvedPath)
      resolvedPaths.push(resolvedPath)
    }
  }
  return resolvedPaths
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ChatRunError('invalid_request', 'The chat run request must be a JSON object.')
  }
  if (typeof request.provider !== 'string' || !request.provider) {
    throw new ChatRunError('invalid_provider', 'A provider is required.')
  }
  if (!SUPPORTED_CHAT_PROVIDERS.has(request.provider)) {
    const gatedReason = GATED_CHAT_PROVIDERS.get(request.provider)
    throw new ChatRunError(
      gatedReason ? 'provider_execution_gated' : 'unsupported_provider',
      gatedReason
        ? `${providerLabel(request.provider)} chat execution is not enabled yet. ${gatedReason}`
        : `${request.provider} chat execution is not supported by Ensync Host yet. Use Codex, Claude Code, or Factory Droid.`,
      422,
    )
  }
  if (!CHAT_PROVIDER_CONTAINMENT[request.provider]) {
    throw new ChatRunError(
      'provider_containment_unrecorded',
      `${request.provider} has no verified workspace-containment record and cannot run.`,
      409,
      false,
    )
  }
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new ChatRunError('invalid_prompt', 'Enter a message before running the chat.')
  }
  if (request.prompt.length > MAX_PROMPT_LENGTH) {
    throw new ChatRunError(
      'invalid_prompt',
      `The message is too large. Ensync Host accepts up to ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`,
      413,
    )
  }
  if (request.sessionId != null && !SESSION_ID_PATTERN.test(request.sessionId)) {
    throw new ChatRunError('invalid_session', 'The conversation session ID is invalid.')
  }
  if (request.model != null && !MODEL_PATTERN.test(request.model)) {
    throw new ChatRunError('invalid_model', 'The requested model name is invalid.')
  }
  if (request.effort != null && !MODEL_EFFORTS.has(request.effort)) {
    throw new ChatRunError('invalid_effort', 'The requested model effort must be low, medium, high, or max.')
  }
  if (request.attachments != null && !Array.isArray(request.attachments)) {
    throw new ChatRunError('invalid_attachments', 'Attached files must be provided as a list.')
  }
  if (
    request.timeoutMs != null
    && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new ChatRunError(
      'invalid_timeout',
      `The timeout must be between 1,000 and ${MAX_TIMEOUT_MS.toLocaleString()} milliseconds.`,
    )
  }
  if (request.autoLand != null && typeof request.autoLand !== 'boolean') {
    throw new ChatRunError('invalid_auto_land', 'The automatic landing preference must be true or false.')
  }
}

function subscriptionAuthenticationAllowed(provider) {
  const method = provider.authentication?.method?.toLowerCase() ?? ''
  if (provider.id === 'codex') return method.includes('chatgpt')
  if (provider.id === 'claude') {
    return ['claude.ai', 'oauth', 'subscription'].some((signal) => method.includes(signal))
  }
  // Factory Droid's browser login is the only subscription-eligible credential:
  // `subscriptionEnvironment` already removes `FACTORY_API_KEY`, and the runner
  // maps a `model_authentication_failed` turn back to `provider_not_authenticated`.
  // The probe reports the stored login as 'Factory browser login'.
  if (provider.id === 'droid') return method.includes('browser login')
  // Cursor's stored browser login is the only subscription-eligible credential:
  // `subscriptionEnvironment` already removes `CURSOR_API_KEY`, and the probe
  // reports the stored login as 'Cursor login'.
  if (provider.id === 'cursor') return method.includes('cursor login')
  return false
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function usageFrom(value) {
  if (!value || typeof value !== 'object') return null
  const inputTokens = integerOrNull(value.input_tokens ?? value.inputTokens)
  const outputTokens = integerOrNull(value.output_tokens ?? value.outputTokens)
  const cachedInputTokens = integerOrNull(
    value.cached_input_tokens
      ?? value.cachedInputTokens
      ?? value.cache_read_input_tokens
      ?? value.cacheReadInputTokens,
  )
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null
  return {
    source: 'cli',
    inputTokens,
    outputTokens,
    cachedInputTokens,
  }
}

function structuredEvents(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const { events } = decodeJsonEventStream(value)
    return events.length ? events : null
  } catch {
    return null
  }
}

function codexEventsProveNoActivity(events) {
  const terminal = events.at(-1)
  if (!terminal || !['turn.failed', 'error'].includes(terminal.type)) return false
  const knownLifecycleEvents = new Set(['thread.started', 'turn.started', 'turn.failed', 'error'])
  const itemEvents = new Set(['item.started', 'item.updated', 'item.completed'])

  return !events.some((event) => {
    if (knownLifecycleEvents.has(event.type)) return false
    if (!itemEvents.has(event.type)) return true
    const itemType = event.item?.type
    return typeof itemType !== 'string' || !['reasoning', 'agent_message'].includes(itemType)
  })
}

function claudeEventsProveNoActivity(events) {
  const terminal = events.at(-1)
  if (!terminal || terminal.type !== 'result' || terminal.is_error !== true) return false
  const knownNonWorkEvents = new Set(['system', 'result', 'rate_limit_event'])

  return !events.some((event) => {
    if (knownNonWorkEvents.has(event.type)) return false
    if (!['assistant', 'user'].includes(event.type)) return true
    const content = event.message?.content ?? event.content
    if (!Array.isArray(content)) return true
    return content.some((block) =>
      !block
      || typeof block !== 'object'
      || !['text', 'thinking', 'redacted_thinking'].includes(block.type))
  })
}

function claudeStartupFailureIsSafe(stdout, stderr, outputTruncated) {
  if (outputTruncated === true || (typeof stderr === 'string' && stderr.trim())) return false
  const events = structuredEvents(stdout)
  if (!events) return false
  return events.every((event) => {
    if (event.type !== 'system') return false
    if (event.subtype === 'init') return true
    if (!['hook_started', 'hook_response'].includes(event.subtype)) return false
    return event.hook_event === 'SessionStart'
      || (typeof event.hook_name === 'string' && event.hook_name.startsWith('SessionStart:'))
  })
}

export function quotaFailureIsSafe(provider, stdout, stderr = '', options = {}) {
  // A capture that dropped provider output cannot prove the run performed no
  // work, so it can never authorize an automatic replay on another provider.
  if (options.outputTruncated) return false
  if (!QUOTA_PATTERN.test(`${stdout}\n${stderr}`)) return false
  const events = structuredEvents(stdout)
  if (!events) return false
  return provider === 'codex'
    ? codexEventsProveNoActivity(events)
    : provider === 'claude' && claudeEventsProveNoActivity(events)
}

function truncatedOutputError(providerName) {
  return new ChatRunError(
    'invalid_cli_output',
    `${providerName} produced more output than Ensync Host's verified run output limit, and the retained stream no longer proves a completed turn. The task was not replayed because partial work may exist.`,
    502,
  )
}

function quotaError(provider, safeToRetry) {
  const name = provider === 'codex' ? 'Codex' : 'Claude Code'
  return new ChatRunError(
    'provider_quota',
    `${name} reported a quota, rate-limit, or capacity failure before any tool activity.`,
    429,
    safeToRetry,
  )
}

export function parseCodexChatResult(stdout, options = {}) {
  const truncation = options.outputTruncated ?? null
  let decoded
  try {
    decoded = decodeJsonEventStream(stdout, { allowRepair: true })
  } catch {
    if (truncation) throw truncatedOutputError('Codex')
    throw new ChatRunError(
      'invalid_cli_output',
      'Ensync Host tried a bounded repair of Codex output but could not verify it as JSON events. The task was not replayed because partial work may exist.',
      502,
    )
  }
  const { events, recovery } = decoded
  if (events.length === 0) {
    if (truncation) throw truncatedOutputError('Codex')
    throw new ChatRunError(
      'invalid_cli_output',
      'Ensync Host tried a bounded repair of Codex output but found no verifiable JSON events. The task was not replayed because partial work may exist.',
      502,
    )
  }
  const agentMessages = []
  let sessionId = null
  let usage = null
  let model = null
  let completed = false
  let failed = false

  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id
    }
    if (
      event.type === 'item.completed'
      && event.item?.type === 'agent_message'
      && typeof event.item.text === 'string'
      && event.item.text.trim()
    ) {
      agentMessages.push(event.item)
    }
    if (event.type === 'turn.completed') {
      completed = true
      usage = usageFrom(event.usage) ?? usage
    }
    if (event.type === 'turn.failed' || event.type === 'error') failed = true
    if (typeof event.model === 'string' && event.model.trim()) model = event.model.trim()
  }

  if (failed) {
    if (quotaFailureIsSafe('codex', stdout, '', { outputTruncated: truncation })) {
      throw quotaError('codex', true)
    }
    throw new ChatRunError('cli_failed', 'Codex reported that the run failed.', 502)
  }
  if (!completed) {
    if (truncation) throw truncatedOutputError('Codex')
    throw new ChatRunError(
      'invalid_cli_output',
      recovery
        ? 'Ensync Host repaired part of Codex output, but no verified terminal completion event remained. The task was not replayed because partial work may exist.'
        : 'Codex returned no verified terminal completion event.',
      502,
    )
  }
  const response = finalCodexResponse(agentMessages)
  if (!response) {
    throw new ChatRunError(
      'empty_cli_response',
      'Codex finished without a verifiable final agent response.',
      502,
    )
  }
  return { response, sessionId, model, usage, outputRecovery: recovery, outputTruncation: truncation }
}

export function parseClaudeChatResult(stdout, options = {}) {
  const truncation = options.outputTruncated ?? null
  let decoded
  try {
    decoded = decodeJsonEventStream(stdout, { allowRepair: true })
  } catch {
    if (truncation) throw truncatedOutputError('Claude Code')
    throw new ChatRunError(
      'invalid_cli_output',
      'Ensync Host tried a bounded repair of Claude Code output but could not verify it as JSON events. The task was not replayed because partial work may exist.',
      502,
    )
  }
  const { events, recovery } = decoded
  if (events.length === 0) {
    if (truncation) throw truncatedOutputError('Claude Code')
    throw new ChatRunError(
      'invalid_cli_output',
      'Ensync Host tried a bounded repair of Claude Code output but found no verifiable JSON events. The task was not replayed because partial work may exist.',
      502,
    )
  }

  // A truncated single-event stream cannot serve as its own terminal result:
  // the dropped lines may have contained the real one.
  const result = [...events].reverse().find((event) => event.type === 'result')
    ?? (events.length === 1 && !truncation ? events[0] : null)

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    if (truncation) throw truncatedOutputError('Claude Code')
    throw new ChatRunError('invalid_cli_output', 'Claude Code returned an invalid result.', 502)
  }
  if (result.is_error === true) {
    if (quotaFailureIsSafe('claude', stdout, '', { outputTruncated: truncation })) {
      throw quotaError('claude', true)
    }
    throw new ChatRunError(
      'cli_failed',
      typeof result.result === 'string' && result.result.trim()
        ? `Claude Code reported an error: ${redactTerminalText(result.result.trim()).text}`
        : 'Claude Code reported that the run failed.',
      502,
    )
  }
  if (result.is_error !== false) {
    if (truncation) throw truncatedOutputError('Claude Code')
    throw new ChatRunError(
      'invalid_cli_output',
      'Claude Code returned no verified success state.',
      502,
    )
  }
  if (typeof result.result !== 'string' || !result.result.trim()) {
    throw new ChatRunError(
      'empty_cli_response',
      'Claude Code finished without a verifiable final agent response.',
      502,
    )
  }

  const modelUsage = result.modelUsage && typeof result.modelUsage === 'object'
    ? Object.keys(result.modelUsage)
    : []
  const initModel = events.find((event) =>
    event.type === 'system'
    && event.subtype === 'init'
    && typeof event.model === 'string')?.model
  const initSessionId = events.find((event) =>
    event.type === 'system'
    && event.subtype === 'init'
    && typeof event.session_id === 'string')?.session_id
  return {
    response: result.result.trim(),
    sessionId: typeof result.session_id === 'string' ? result.session_id : initSessionId ?? null,
    model: modelUsage.length === 1 ? modelUsage[0] : initModel ?? null,
    usage: usageFrom(result.usage),
    outputRecovery: recovery,
    outputTruncation: truncation,
  }
}

function codexImagePaths(attachmentPaths = []) {
  return attachmentPaths.filter((attachmentPath) => CODEX_IMAGE_EXTENSIONS.has(extname(attachmentPath).toLowerCase()))
}

// Pinned per Step 0 verification against the installed Codex CLI (codex-cli 0.146.0):
// `codex exec --help` documents `-s/--sandbox <SANDBOX_MODE>` with `workspace-write` as a
// possible value; `-c` accepts dotted-path TOML overrides, and `sandbox_workspace_write.writable_roots`
// is a documented config key ("Additional writable roots when sandbox_mode = \"workspace-write\"").
// Host, not the renderer, chooses these flags — they are not user- or renderer-selectable.
//
// `codex exec resume` does NOT accept `--sandbox` — verified against the installed binary:
// `codex exec resume --sandbox workspace-write ...` -> `error: unexpected argument '--sandbox'
// found` (exit 2, argv parse failure, before any session lookup). On resume the sandbox must be
// expressed purely as `-c` config overrides instead; verified this parses and passes
// `--strict-config` (the invocation proceeds to a real `thread/resume` session lookup rather
// than an argv error).
function codexContainmentArguments(containment, { resume = false } = {}) {
  if (!containment) return []
  const writableRootsArgs = ['-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(containment.worktreePath)}]`]
  if (resume) {
    return ['-c', 'sandbox_mode="workspace-write"', ...writableRootsArgs]
  }
  return ['--sandbox', 'workspace-write', ...writableRootsArgs]
}

function codexArguments(request, attachmentPaths = [], containment = null) {
  const modelArgs = request.model ? ['--model', request.model] : []
  const effortArgs = request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []
  const imagePaths = codexImagePaths(attachmentPaths)
  const imageArgs = imagePaths.length > 0 ? ['--image', ...imagePaths] : []
  if (request.sessionId) {
    const containmentArgs = codexContainmentArguments(containment, { resume: true })
    return ['exec', 'resume', ...imageArgs, ...containmentArgs, '--json', '--skip-git-repo-check', ...modelArgs, ...effortArgs, request.sessionId, '-']
  }
  const containmentArgs = codexContainmentArguments(containment)
  return ['exec', ...imageArgs, ...containmentArgs, '--json', '--color', 'never', '--skip-git-repo-check', ...modelArgs, ...effortArgs, '-']
}

// Pinned per Step 0 verification against the installed Claude Code CLI (2.1.226): `claude --help`
// documents `--settings <file-or-json>`; the bundled settings schema documents `permissions.deny`
// as a string array, and the CLI's own permission-rule validator documents `Tool(specifier)` glob
// syntax with examples including `Edit(docs/**)`, with "Write", "Edit", and "NotebookEdit" all in
// its `filePatternTools` list. Host, not the renderer, chooses these flags. This is a fail-open
// gap, not a sandbox: see the CHAT_PROVIDER_CONTAINMENT claude record for the `-p` mode
// silent-validation-failure and Bash-is-unconstrained caveats.
function claudeContainmentArguments(containment) {
  if (!containment) return []
  const settings = {
    permissions: {
      deny: [
        `Write(${containment.canonicalRepositoryPath}/**)`,
        `Edit(${containment.canonicalRepositoryPath}/**)`,
        `NotebookEdit(${containment.canonicalRepositoryPath}/**)`,
      ],
    },
  }
  return ['--settings', JSON.stringify(settings)]
}

function claudeArguments(request, containment = null, { questions = false } = {}) {
  const args = ['--print', '--verbose', '--output-format', 'stream-json']
  if (request.model) args.push('--model', request.model)
  if (request.effort) args.push('--effort', request.effort)
  if (request.sessionId) args.push('--resume', request.sessionId)
  args.push(...claudeContainmentArguments(containment))
  // Only a run that can carry an answer back opens the interactive channel;
  // see claude-questions.mjs for why these two flags travel together.
  if (questions) args.push(...claudeQuestionArguments())
  return args
}

export function argumentsFor(request, attachmentPaths = [], containment = null, options = {}) {
  return request.provider === 'codex'
    ? codexArguments(request, attachmentPaths, containment)
    : claudeArguments(request, containment, options)
}

function parseResult(provider, stdout, options = {}) {
  return provider === 'codex'
    ? parseCodexChatResult(stdout, options)
    : parseClaudeChatResult(stdout, options)
}

export class ChatRunService {
  #statusService
  #processRunner
  #allowedRoots
  #environment
  #inactivityTimeoutMs
  #questionHoldTimeoutMs
  #hardTimeoutMs
  #codexLiveTurns
  #droidExecRuns
  #cursorAgentRuns
  #codebuddyExecRuns
  /** Live Claude interactive channels, keyed by the retained job that owns them. */
  #claudeQuestionChannels = new Map()
  #projectIsolation
  #workspaceOverlapMonitor
  #autoLand
  #autoPushLanded
  #gitExecutable
  #landCheck
  #activeRuns = 0

  constructor(options = {}) {
    if (!options.statusService) throw new TypeError('ChatRunService requires a provider status service.')
    this.#statusService = options.statusService
    this.#processRunner = options.processRunner ?? runProcess
    this.#allowedRoots = options.allowedRoots
    this.#environment = options.environment ?? process.env
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
    this.#questionHoldTimeoutMs = options.questionHoldTimeoutMs ?? DEFAULT_QUESTION_HOLD_TIMEOUT_MS
    this.#hardTimeoutMs = options.hardTimeoutMs
      ?? configuredHardTimeoutMs(this.#environment, INVALID_HARD_TIMEOUT_FALLBACK_MS)
    this.#projectIsolation = options.projectIsolation ?? null
    this.#workspaceOverlapMonitor = options.workspaceOverlapMonitor ?? null
    this.#autoLand = options.autoLand !== false
    this.#autoPushLanded = options.autoPushLanded !== false
    this.#gitExecutable = options.gitExecutable
    this.#landCheck = options.landCheck ?? runLandCheck
    this.#codexLiveTurns = options.codexLiveTurnRunner ?? new CodexLiveTurnRunner({
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    })
    this.#droidExecRuns = options.droidExecRunner ?? new DroidExecRunner({
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      questionHoldTimeoutMs: this.#questionHoldTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    })
    this.#cursorAgentRuns = options.cursorAgentRunner ?? new CursorAgentRunner({
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    })
    this.#codebuddyExecRuns = options.codebuddyExecRunner ?? new CodebuddyExecRunner({
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    })
  }

  async run(request, options = {}) {
    validateRequest(request)
    throwIfCancelled(options.signal)
    const projectPath = await validateProjectPath(request.projectPath, {
      allowedRoots: this.#allowedRoots,
    })
    throwIfCancelled(options.signal)
    const attachmentPaths = await validateAttachmentPaths(request.attachments)
    throwIfCancelled(options.signal)
    const provider = await this.#statusService.get(request.provider, { refresh: true })
    throwIfCancelled(options.signal)

    if (!provider?.installed || !provider.executable) {
      throw new ChatRunError(
        'provider_unavailable',
        `${providerLabel(request.provider)} is not installed or is not available on PATH.`,
        409,
        true,
      )
    }
    if (provider.authentication?.state !== 'authenticated') {
      throw new ChatRunError(
        'provider_not_authenticated',
        provider.authentication?.reason
          ?? `${provider.name} is not authenticated. Connect it before running a chat.`,
        409,
        true,
      )
    }
    if (!subscriptionAuthenticationAllowed(provider)) {
      throw new ChatRunError(
        'subscription_auth_required',
        `${provider.name} must be connected through a subscription login. Ensync Host will not run chat through API-key, Bedrock, Vertex, or Foundry credentials.`,
        409,
        true,
      )
    }

    let workspaceLease = options.preAcquiredWorkspaceLease ?? null
    const ownsWorkspaceLease = workspaceLease === null
    let workspace = null
    let workspaceOverlapSession = null
    let workspaceOverlaps = []
    let combinedSignal = { signal: options.signal, dispose() {} }
    if (workspaceLease || this.#projectIsolation) {
      try {
        if (!workspaceLease) {
          workspaceLease = await this.#projectIsolation.acquire(projectPath, request.workspaceKey, {
            signal: options.signal,
            onWait: () => options.onEvent?.({
              type: 'notice',
              code: 'workspace_write_lock_waiting',
              message: 'Waiting for this conversation’s protected workspace to become available. Another run in this same chat is using it; other chats can run concurrently. No provider process has started.',
              at: new Date().toISOString(),
            }),
          })
        }
        workspace = workspaceLease.workspace
        combinedSignal = combinedAbortSignal(options.signal, workspaceLease.signal)
        const baseSummary = workspaceBaseSummary(workspace)
        const baselineConflict = boundedBaselineConflict(workspace)
        const deferredBaselineSummary = baselineConflict
          ? ` Baseline reconciliation is deferred until landing; Ensync restored this exact conversation branch to a clean state so work can continue now.`
          : ''
        options.onEvent?.({
          type: 'notice',
          code: 'project_workspace_ready',
          message: `Protected workspace ready on ${workspace.branch} at ${workspace.projectPath}. The shared checkout will not be used as the provider working directory.${baseSummary ? ` ${baseSummary}` : ''}${deferredBaselineSummary}`,
          workspace: {
            path: workspace.projectPath,
            branch: workspace.branch,
            base: workspace.base ?? null,
            integration: workspace.integration ?? null,
            baselineConflict,
          },
          at: new Date().toISOString(),
        })
      } catch (error) {
        if (error instanceof ChatRunError) throw error
        throw new ChatRunError(
          typeof error?.code === 'string' ? error.code : 'project_isolation_failed',
          error instanceof Error ? error.message : 'Ensync Host could not prepare a protected project workspace.',
          Number.isInteger(error?.status) ? error.status : 409,
          false,
        )
      }
    }
    const executionProjectPath = workspace?.projectPath ?? projectPath
    if (workspace && this.#workspaceOverlapMonitor) {
      try {
        workspaceOverlapSession = await this.#workspaceOverlapMonitor.start(workspace, {
          jobId: typeof options.liveTurnId === 'string' && options.liveTurnId
            ? options.liveTurnId
            : workspace.branch,
          signal: combinedSignal.signal,
          onEvent: (event) => options.onEvent?.(event),
        })
        workspaceOverlaps = workspaceOverlapSession.current()
      } catch (error) {
        options.onEvent?.({
          type: 'notice',
          code: 'workspace_overlap_unavailable',
          message: `Ensync could not start cross-conversation file awareness: ${error instanceof Error ? error.message : 'unknown error'}. Protected workspace isolation remains active.`,
          at: new Date().toISOString(),
        })
      }
    }
    // Every provider runner — codex exec, the codex live turn, claude resume,
    // and droid — receives the same bundled Ensync agent-coordination contract
    // ahead of the user's prompt (and ahead of any workspace isolation header).
    // Remove a renderer-supplied complete envelope before adding isolation, then
    // always apply the current contract so marker-shaped user text cannot bypass it.
    const promptBody = withoutLeadingEnsyncMultiAgentInstructions(request.prompt)
    const executionRequest = {
      ...request,
      prompt: withEnsyncMultiAgentInstructions(
        workspace ? isolatedPrompt(promptBody, workspace, workspaceOverlaps) : promptBody,
      ),
    }
    const publicWorkspace = workspace ? {
      path: workspace.projectPath,
      repositoryPath: workspace.repositoryPath,
      branch: workspace.branch,
      reused: workspace.reused,
      base: workspace.base ?? null,
      integration: workspace.integration ?? null,
      baselineConflict: boundedBaselineConflict(workspace),
      gitBefore: workspace.gitBefore,
    } : null
    // workspace.repositoryPath is the writable worktree; workspace.shared.repositoryPath is the
    // canonical shared checkout that provider processes must not write to directly.
    const containment = workspace ? {
      worktreePath: workspace.repositoryPath,
      canonicalRepositoryPath: workspace.shared.repositoryPath,
    } : null

    let runOutcome = 'failed'
    try {
    if (request.provider === 'codex' && typeof options.liveTurnId === 'string' && options.liveTurnId) {
      this.#activeRuns += 1
      try {
        // Live-turn containment is pinned in codex-live-turn session configuration; verify
        // separately before enabling sandbox there. Step 0 verification for this task found a
        // `sandboxPolicy` field on `TurnStartParams` in the app-server v2 protocol schema, but
        // could not confirm it applies under the non-experimental `initialize` handshake this
        // runner uses (no `experimentalApi: true`), so it was not pinned here. Do not guess.
        const result = await this.#codexLiveTurns.run({
          id: options.liveTurnId,
          executable: provider.executable,
          projectPath: executionProjectPath,
          prompt: executionRequest.prompt,
          attachmentPaths,
          sessionId: request.sessionId ?? null,
          model: request.model ?? null,
          effort: request.effort ?? null,
          env: subscriptionEnvironment(this.#environment),
        }, {
          signal: combinedSignal.signal,
          onEvent: (event) => options.onEvent?.(redactedRunEvent(event)),
        })
        workspaceLease?.assertHeld()
        runOutcome = 'succeeded'
        return { ...result, projectPath, workspace: publicWorkspace }
      } catch (error) {
        if (workspaceLease?.signal.aborted && !options.signal?.aborted) {
          const reason = workspaceLease.signal.reason
          throw new ChatRunError(
            'workspace_write_lock_lost',
            reason instanceof Error ? reason.message : 'Ensync Host lost the protected workspace write lease. Partial work may exist in the protected worktree.',
            409,
            false,
          )
        }
        if (error instanceof CodexLiveTurnError) {
          throw new ChatRunError(error.code, error.message, error.status, error.safeToRetry)
        }
        throw error
      } finally {
        this.#activeRuns -= 1
        this.#statusService.invalidate?.()
      }
    }

    if (request.provider === 'droid') {
      this.#activeRuns += 1
      try {
        // Droid has no argv containment flags: `cwd` plus the pinned per-session
        // autonomy level is the whole enforcement surface, and the runner verifies
        // the CLI echoed that level back before it sends the prompt.
        const result = await this.#droidExecRuns.run({
          // The retained job ID is what lets a `droid.ask_user` questionnaire or
          // a `droid.request_permission` reach the renderer instead of being
          // declined: it is the address the reply comes back to.
          id: typeof options.liveTurnId === 'string' && options.liveTurnId ? options.liveTurnId : null,
          executable: provider.executable,
          projectPath: executionProjectPath,
          prompt: executionRequest.prompt,
          attachmentPaths,
          sessionId: request.sessionId ?? null,
          model: request.model ?? null,
          effort: request.effort ?? null,
          env: subscriptionEnvironment(this.#environment),
        }, {
          signal: combinedSignal.signal,
          onEvent: (event) => options.onEvent?.(redactedRunEvent(event)),
        })
        workspaceLease?.assertHeld()
        runOutcome = 'succeeded'
        return { ...result, projectPath, workspace: publicWorkspace }
      } catch (error) {
        if (workspaceLease?.signal.aborted && !options.signal?.aborted) {
          const reason = workspaceLease.signal.reason
          throw new ChatRunError(
            'workspace_write_lock_lost',
            reason instanceof Error ? reason.message : 'Ensync Host lost the protected workspace write lease. Partial work may exist in the protected worktree.',
            409,
            false,
          )
        }
        if (error instanceof DroidExecError) {
          throw new ChatRunError(error.code, error.message, error.status, error.safeToRetry)
        }
        throw error
      } finally {
        this.#activeRuns -= 1
        this.#statusService.invalidate?.()
      }
    }

    if (request.provider === 'cursor') {
      this.#activeRuns += 1
      try {
        // Cursor's containment is argv-pinned by the runner itself: the spawn cwd
        // plus `--workspace`, and `--sandbox enabled`, which the CLI refuses to
        // start without on a host that cannot apply it. There is no per-run
        // permission surface to hand a person, so this runner takes no retained
        // job ID: a headless Cursor turn answers every interactive request from a
        // fixed table and never blocks on an answer.
        const result = await this.#cursorAgentRuns.run({
          executable: provider.executable,
          projectPath: executionProjectPath,
          prompt: executionRequest.prompt,
          sessionId: request.sessionId ?? null,
          model: request.model ?? null,
          effort: request.effort ?? null,
          env: subscriptionEnvironment(this.#environment),
        }, {
          signal: combinedSignal.signal,
          onEvent: (event) => options.onEvent?.(redactedRunEvent(event)),
        })
        workspaceLease?.assertHeld()
        runOutcome = 'succeeded'
        return { ...result, projectPath, workspace: publicWorkspace }
      } catch (error) {
        if (workspaceLease?.signal.aborted && !options.signal?.aborted) {
          const reason = workspaceLease.signal.reason
          throw new ChatRunError(
            'workspace_write_lock_lost',
            reason instanceof Error ? reason.message : 'Ensync Host lost the protected workspace write lease. Partial work may exist in the protected worktree.',
            409,
            false,
          )
        }
        if (error instanceof CursorAgentError) {
          throw new ChatRunError(error.code, error.message, error.status, error.safeToRetry)
        }
        throw error
      } finally {
        this.#activeRuns -= 1
        this.#statusService.invalidate?.()
      }
    }

    if (request.provider === 'codebuddy') {
      this.#activeRuns += 1
      try {
        // Unreachable while `codebuddy` sits in GATED_CHAT_PROVIDERS — validateRequest
        // refuses it first. It is wired now so that promotion is a one-line catalog
        // change once an authenticated turn has been verified, not a re-implementation.
        //
        // CodeBuddy's containment is the spawn cwd plus `--permission-mode` and
        // `--settings` deny rules, none of which are self-proving: an unrecognised
        // mode is silently discarded. The runner therefore holds stdin open, waits
        // for `system.init` to echo the effective mode and cwd, and only then
        // releases the prompt — the same verify-before-you-send contract droid uses.
        const result = await this.#codebuddyExecRuns.run({
          executable: provider.executable,
          projectPath: executionProjectPath,
          prompt: executionRequest.prompt,
          sessionId: request.sessionId ?? null,
          model: request.model ?? null,
          effort: request.effort ?? null,
          containment,
          env: subscriptionEnvironment(this.#environment),
        }, {
          signal: combinedSignal.signal,
          onEvent: (event) => options.onEvent?.(redactedRunEvent(event)),
        })
        workspaceLease?.assertHeld()
        runOutcome = 'succeeded'
        return { ...result, projectPath, workspace: publicWorkspace }
      } catch (error) {
        if (workspaceLease?.signal.aborted && !options.signal?.aborted) {
          const reason = workspaceLease.signal.reason
          throw new ChatRunError(
            'workspace_write_lock_lost',
            reason instanceof Error ? reason.message : 'Ensync Host lost the protected workspace write lease. Partial work may exist in the protected worktree.',
            409,
            false,
          )
        }
        if (error instanceof CodebuddyExecError) {
          throw new ChatRunError(error.code, error.message, error.status, error.safeToRetry)
        }
        throw error
      } finally {
        this.#activeRuns -= 1
        this.#statusService.invalidate?.()
      }
    }

    const startedAt = Date.now()
    // A null hard ceiling means "no absolute run limit": the inactivity
    // watchdog alone detects hung providers, so runProcess starts no hard timer.
    const hardTimeoutMs = request.timeoutMs ?? this.#hardTimeoutMs
    const inactivityTimeoutMs = hardTimeoutMs == null
      ? this.#inactivityTimeoutMs
      : Math.min(this.#inactivityTimeoutMs, hardTimeoutMs)
    // Claude only opens its interactive question channel for a retained job:
    // a run nobody can answer must keep behaving exactly as it does today.
    const jobId = typeof options.liveTurnId === 'string' && options.liveTurnId ? options.liveTurnId : null
    const questionsEnabled = request.provider === 'claude' && Boolean(jobId)
    let session = null
    const questionChannel = questionsEnabled
      ? createClaudeQuestionChannel({
          write: (chunk) => session?.write(chunk),
          endInput: () => session?.endInput(),
          hold: () => session?.holdInactivity(),
          release: () => session?.releaseInactivity(),
          onEvent: (event) => options.onEvent?.(redactedRunEvent(event)),
        })
      : null
    const args = argumentsFor(executionRequest, attachmentPaths, containment, { questions: questionsEnabled })
    const forwarder = outputForwarder(options.onEvent, request.provider, {
      onStdoutLine: questionChannel ? (line) => questionChannel.handleLine(line) : undefined,
    })
    // Registered last, so nothing between here and the try/finally that
    // removes it can leave a channel stranded in the map.
    if (questionChannel) this.#claudeQuestionChannels.set(jobId, questionChannel)
    this.#activeRuns += 1
    let processResult
    try {
      options.onEvent?.({
        type: 'started',
        provider: request.provider,
        cwd: executionProjectPath,
        command: [provider.executable, ...visibleArguments(executionRequest, attachmentPaths, containment, { questions: questionsEnabled })].map(quoteTerminalArgument).join(' '),
        at: new Date(startedAt).toISOString(),
      })
      processResult = await this.#processRunner(
        provider.executable,
        args,
        {
          cwd: executionProjectPath,
          env: subscriptionEnvironment(this.#environment),
          input: questionsEnabled ? claudeUserMessageLine(executionRequest.prompt) : executionRequest.prompt,
          keepStdinOpen: questionsEnabled,
          onSession: questionsEnabled ? (handle) => { session = handle } : undefined,
          inactivityTimeoutMs,
          questionHoldTimeoutMs: questionsEnabled ? this.#questionHoldTimeoutMs : null,
          hardTimeoutMs,
          maxCaptureBytes: MAX_CHAT_OUTPUT_BYTES,
          onStdout: forwarder.stdout,
          onStderr: forwarder.stderr,
          signal: combinedSignal.signal,
        },
      )
    } finally {
      this.#activeRuns -= 1
      if (questionChannel) {
        questionChannel.close()
        this.#claudeQuestionChannels.delete(jobId)
      }
      forwarder.flush()
      // A completed, failed, or cancelled CLI process may have changed the account's real
      // usage window. Drop the shared Host cache so every renderer's next non-forced read
      // observes a fresh provider probe without each window forcing its own subprocesses.
      this.#statusService.invalidate?.()
    }

    if (workspaceLease?.signal.aborted && !options.signal?.aborted) {
      const reason = workspaceLease.signal.reason
      throw new ChatRunError(
        'workspace_write_lock_lost',
        reason instanceof Error ? reason.message : 'Ensync Host lost the protected workspace write lease. Partial work may exist in the protected worktree.',
        409,
        false,
      )
    }
    if (processResult.aborted || options.signal?.aborted) throw cancelledRunError()
    if (processResult.timedOut) {
      throw new ChatRunError(
        'run_timed_out',
        timeoutMessage(provider.name, processResult.timeoutReason),
        504,
      )
    }
    if (processResult.error) {
      throw new ChatRunError(
        'run_start_failed',
        `${provider.name} could not be started by Ensync Host.`,
        502,
        true,
      )
    }
    const outputTruncated = processResult.truncation?.stdout
      ?? (processResult.outputTruncated ? true : null)
    if (processResult.exitCode !== 0) {
      if (quotaFailureIsSafe(request.provider, processResult.stdout, processResult.stderr, { outputTruncated })) {
        throw quotaError(request.provider, true)
      }
      if (
        request.provider === 'claude'
        && claudeStartupFailureIsSafe(
          processResult.stdout,
          processResult.stderr,
          processResult.outputTruncated,
        )
      ) {
        throw new ChatRunError(
          'provider_startup_failed',
          'Claude Code stopped during startup before any assistant or tool activity. Ensync can continue safely with the next connected provider.',
          502,
          true,
        )
      }
      const output = processResult.stderr || processResult.stdout
      const reason = output ? ` ${redactTerminalText(output.slice(0, 500)).text}` : ''
      throw new ChatRunError(
        'cli_failed',
        `${describeProcessExit(provider.name, processResult)}.${reason}`,
        502,
      )
    }

    const parsed = parseResult(request.provider, processResult.stdout, { outputTruncated })
    workspaceLease?.assertHeld()
    runOutcome = 'succeeded'
    return {
      provider: request.provider,
      projectPath,
      workspace: publicWorkspace,
      response: parsed.response,
      sessionId: parsed.sessionId ?? request.sessionId ?? null,
      model: parsed.model,
      requestedModel: request.model ?? null,
      requestedEffort: request.effort ?? null,
      usage: parsed.usage,
      outputRecovery: parsed.outputRecovery,
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    }
    } catch (error) {
      if (error?.code === 'run_cancelled') runOutcome = 'cancelled'
      else if (error?.code === 'run_timed_out') runOutcome = 'timed_out'
      throw error
    } finally {
      combinedSignal.dispose()
      if (workspace && this.#projectIsolation && !workspaceLease?.signal.aborted) {
        let agentWorkSaved = true
        try {
          const workCommit = await this.#projectIsolation.commitAgentWork(workspace, {
            outcome: runOutcome,
            provider: request.provider,
            jobId: typeof options.jobId === 'string' ? options.jobId : (typeof options.liveTurnId === 'string' ? options.liveTurnId : null),
          })
          if (workCommit.committed) {
            options.onEvent?.({
              type: 'notice',
              code: 'agent_work_committed',
              message: `Saved ${workCommit.changedFiles} changed file${workCommit.changedFiles === 1 ? '' : 's'} to ${workspace.branch} (run ${runOutcome}).`,
              at: new Date().toISOString(),
            })
          }
        } catch (commitError) {
          agentWorkSaved = false
          options.onEvent?.({
            type: 'notice',
            code: 'agent_work_commit_failed',
            message: `Ensync could not save this run's work to ${workspace.branch}: ${commitError instanceof Error ? commitError.message : 'unknown error'}. The changes remain in the protected worktree and need review.`,
            at: new Date().toISOString(),
          })
        }
        try {
          const sharedCheck = await this.#projectIsolation.checkSharedCheckout(workspace)
          if (sharedCheck.available && sharedCheck.changed) {
            const message = sharedCheck.destructive
              ? `Previously modified files in the shared checkout at ${workspace.shared.repositoryPath} were reverted while this run was active, with no commit containing those changes. Ensync did not change the shared checkout. Review it before relying on its state.`
              : sharedCheck.landed
                ? `Explicit Ensync land merges arrived on ${workspace.shared.repositoryPath} while this run was active, and its uncommitted state also changed. Ensync changed it only through the explicit land; you may have edited concurrently.`
                : `The shared checkout at ${workspace.shared.repositoryPath} changed while this run was active. Ensync did not change it; you may have edited or committed concurrently.`
            options.onEvent?.({
              type: 'notice',
              code: sharedCheck.destructive ? 'shared_checkout_reverted' : 'shared_checkout_changed',
              message,
              at: new Date().toISOString(),
            })
          }
        } catch {
          // Shared-checkout detection is best-effort; never let it mask the run's own outcome or skip lease release.
        }
        await refreshOverlapSession(workspaceOverlapSession, options.onEvent)
        if (runOutcome === 'succeeded' && this.#autoLand && request.autoLand !== false && agentWorkSaved && !options.signal?.aborted) {
          await this.#autoLandAfterRun(
            provider,
            request,
            workspace,
            containment,
            workspaceLease,
            workspaceOverlapSession,
            options,
          )
        }
      }
      await stopOverlapSession(workspaceOverlapSession, options.onEvent)
      const leaseRelease = ownsWorkspaceLease ? await workspaceLease?.release() : null
      // A lease that could not be deleted is the one failure nobody sees from
      // the outside: this run ends normally while the next message in the same
      // conversation waits on a lock with nothing behind it.
      if (leaseRelease && leaseRelease.removed === false) {
        options.onEvent?.({
          type: 'notice',
          code: 'workspace_lease_release_failed',
          message: `${leaseRelease.reason} Ensync Host reclaims it automatically once it goes stale, so the next message in this conversation may wait briefly before it starts.`,
          at: new Date().toISOString(),
        })
      }
    }
  }

  /**
   * Automatic landing runs only for verified successful local runs whose work
   * committed cleanly; failed, cancelled, timed-out, and SSH runs keep their
   * branches unlanded for explicit review. Any failure here is reported as a
   * notice and never changes the finished run's outcome.
   */
  async #autoLandAfterRun(provider, request, workspace, containment, workspaceLease, overlapSession, options) {
    const landSignal = combinedAbortSignal(options.signal, workspaceLease?.signal)
    try {
      await autoLandWorkspace(workspace, {
        allowedRoots: this.#allowedRoots,
        gitExecutable: this.#gitExecutable,
        signal: landSignal.signal,
        onNotice: (code, message) => options.onEvent?.({
          type: 'notice',
          code,
          message,
          at: new Date().toISOString(),
        }),
        runConflictAgent: async (details) => {
          const overlaps = await refreshOverlapSession(overlapSession, options.onEvent)
          return this.#runConflictResolutionAgent(provider, request, workspace, containment, {
            ...details,
            overlaps,
          }, {
            onEvent: options.onEvent,
            signal: landSignal.signal,
          })
        },
        verifyLand: (details) => this.#landCheck(details.repositoryPath, {
          environment: this.#environment,
          signal: landSignal.signal,
        }),
        runRepairAgent: async (details) => {
          const overlaps = await refreshOverlapSession(overlapSession, options.onEvent)
          return this.#runLandCheckRepairAgent(provider, request, workspace, containment, {
            ...details,
            overlaps,
          }, {
            onEvent: options.onEvent,
            signal: landSignal.signal,
          })
        },
        autoPush: this.#autoPushLanded,
      })
    } catch (error) {
      options.onEvent?.({
        type: 'notice',
        code: 'auto_land_failed',
        message: `Automatic landing of ${workspace.branch} failed: ${error instanceof Error ? error.message : 'unknown error'}. The work stays on ${workspace.branch} for explicit review and landing.`,
        at: new Date().toISOString(),
      })
    } finally {
      landSignal.dispose()
    }
  }

  /**
   * Runs the same provider CLI as a fresh, sessionless turn inside the
   * protected worktree to resolve an in-progress baseline merge. The run is
   * verified the same way a normal run is: process exit, cancellation,
   * timeout, and a parseable completed provider result.
   */
  async #runConflictResolutionAgent(provider, request, workspace, containment, details, runtime) {
    await this.#runWorktreeAgentRun(provider, request, workspace, containment, conflictResolutionPrompt(details), {
      code: 'conflict_resolution_failed',
      label: 'conflict-resolution',
    }, runtime)
  }

  /** Same contained provider run, prompted to repair a rolled-back land check. */
  async #runLandCheckRepairAgent(provider, request, workspace, containment, details, runtime) {
    await this.#runWorktreeAgentRun(provider, request, workspace, containment, landCheckRepairPrompt(details), {
      code: 'land_check_repair_failed',
      label: 'land-check repair',
    }, runtime)
  }

  async #runWorktreeAgentRun(provider, request, workspace, containment, rawPrompt, failure, runtime) {
    const prompt = withEnsyncMultiAgentInstructions(rawPrompt)
    const subRequest = {
      provider: request.provider,
      prompt,
      model: request.model ?? null,
      effort: request.effort ?? null,
    }
    const args = argumentsFor(subRequest, [], containment)
    const forwarder = outputForwarder(runtime.onEvent, request.provider)
    this.#activeRuns += 1
    let processResult
    try {
      processResult = await this.#processRunner(provider.executable, args, {
        cwd: workspace.repositoryPath,
        env: subscriptionEnvironment(this.#environment),
        input: prompt,
        inactivityTimeoutMs: this.#hardTimeoutMs == null
          ? this.#inactivityTimeoutMs
          : Math.min(this.#inactivityTimeoutMs, this.#hardTimeoutMs),
        hardTimeoutMs: this.#hardTimeoutMs,
        maxCaptureBytes: MAX_CHAT_OUTPUT_BYTES,
        onStdout: forwarder.stdout,
        onStderr: forwarder.stderr,
        signal: runtime.signal,
      })
    } finally {
      this.#activeRuns -= 1
      forwarder.flush()
      this.#statusService.invalidate?.()
    }
    if (processResult.aborted || runtime.signal?.aborted) {
      throw new ChatRunError('run_cancelled', `The ${failure.label} agent run was cancelled.`, 499)
    }
    if (processResult.timedOut) {
      throw new ChatRunError('run_timed_out', timeoutMessage(provider.name, processResult.timeoutReason), 504)
    }
    if (processResult.error || processResult.exitCode !== 0) {
      const output = processResult.stderr || processResult.stdout
      const reason = output ? ` ${redactTerminalText(output.slice(0, 300)).text}` : ''
      throw new ChatRunError(failure.code, `${describeProcessExit(provider.name, processResult)}.${reason}`, 502)
    }
    parseResult(request.provider, processResult.stdout, {
      outputTruncated: processResult.truncation?.stdout ?? (processResult.outputTruncated ? true : null),
    })
  }

  hasRunningRuns() {
    return this.#activeRuns > 0
  }

  canSteer(jobId) {
    return this.#codexLiveTurns.canSteer(jobId)
  }

  /** Questions a live run is currently blocked on, for a renderer that reconnects mid-turn. */
  pendingQuestions(jobId) {
    if (typeof jobId !== 'string' || !jobId) return []
    const claude = this.#claudeQuestionChannels.get(jobId)
    if (claude) return claude.registry.list()
    return this.#droidExecRuns.pendingQuestions(jobId)
  }

  /**
   * Delivers a person's answer to whichever live runner asked. The answer is
   * never invented: an unanswered or malformed payload is refused so the
   * provider hears the person's words or an explicit cancellation, nothing else.
   */
  answerQuestion(jobId, input) {
    if (typeof jobId !== 'string' || !jobId) {
      throw new ChatRunError('invalid_chat_job', 'A retained chat job ID is required.', 400, true)
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ChatRunError('invalid_request', 'An answer payload is required.', 400, true)
    }
    if (typeof input.questionId !== 'string' || !input.questionId) {
      throw new ChatRunError('invalid_question_answer', 'The question being answered must be identified.', 400, true)
    }
    const claude = this.#claudeQuestionChannels.get(jobId)
    // Only a provider that can be asked a question can be answered; anything
    // else is refused by name rather than blamed on one provider's runner.
    if (!claude && !this.#droidExecRuns.hasSession(jobId)) {
      throw new ChatRunError(
        'question_not_found',
        'That run is not waiting on a question, so the answer was not delivered.',
        409,
        false,
      )
    }
    try {
      const resolution = claude
        ? claude.registry.answer(input.questionId, input)
        : this.#droidExecRuns.answerQuestion(jobId, input.questionId, input)
      if (!resolution) {
        throw new ChatRunError(
          'question_not_found',
          'That run is not waiting on a question, so the answer was not delivered.',
          409,
          false,
        )
      }
      return resolution
    } catch (error) {
      if (error instanceof ProviderQuestionError || error instanceof DroidExecError) {
        throw new ChatRunError(error.code, error.message, error.status, error.safeToRetry)
      }
      throw error
    }
  }

  async steer(liveTurnId, input) {
    if (typeof liveTurnId !== 'string' || !liveTurnId) {
      throw new ChatRunError('invalid_chat_job', 'A retained chat job ID is required.', 400, true)
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ChatRunError('invalid_request', 'A live instruction is required.', 400, true)
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      throw new ChatRunError('invalid_prompt', 'Enter a message before steering the active turn.', 400, true)
    }
    if (input.prompt.length > MAX_PROMPT_LENGTH) {
      throw new ChatRunError(
        'invalid_prompt',
        `The message is too large. Ensync Host accepts up to ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`,
        413,
        true,
      )
    }
    const attachmentPaths = await validateAttachmentPaths(input.attachments)
    try {
      return await this.#codexLiveTurns.steer(liveTurnId, input.prompt.trim(), attachmentPaths)
    } catch (error) {
      if (error instanceof CodexLiveTurnError) {
        throw new ChatRunError(error.code, error.message, error.status, error.safeToRetry)
      }
      throw error
    }
  }
}

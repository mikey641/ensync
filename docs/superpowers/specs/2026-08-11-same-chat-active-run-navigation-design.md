# Same-chat active-run navigation and push — design

Date: 2026-08-11
Status: approved

## Problem

Ensync correctly serializes two jobs that target one conversation workspace. The
second job waits before a provider process starts, preserving the protected
worktree and allowing unrelated chats to continue concurrently. The waiting UI,
however, receives only a generic `workspace_write_lock_waiting` notice. It
cannot identify the job or native window that owns the lease, navigate to that
conversation, or offer the existing safe `Push now` behavior for the waiting
message.

This is an ownership-observability failure, not a failure of the workspace
lease. The lease record currently contains a token, Host PID, workspace hash,
and timestamps. The Host job registry knows individual job IDs but does not
admit or look them up by canonical conversation workspace. The native shell can
focus a workspace window for a project, but it has no exact chat/job target.

## User-approved behavior

1. A second message for an already-running conversation stays visibly queued;
   it must not start another provider job that waits on the filesystem lease.
2. The waiting surface offers **View active run** when Ensync can verify and
   focus the owner window and exact conversation.
3. The queued message offers **Push now** only when Ensync Host verifies that
   the owner is the exact still-active, steerable local Codex turn.
4. Claude, SSH, older/non-steerable Codex jobs, and every other provider retain
   the separate two-step **Stop & send now** behavior. Stopping work must never
   be presented as steering.
5. A proven steering rejection keeps the message queued. An ambiguous delivery
   removes it from automatic execution and marks it interrupted so it can never
   run twice.
6. Different conversations remain concurrent. macOS and Windows receive the
   same behavior and safety guarantees.

## Approaches considered

### Saved-workspace scan only

The renderer could scan checksummed retained workspace snapshots for the same
project and chat ID, then focus the strongest match. This is small, but saved
state can be stale and cannot prove which job owns the live lease. It may power
fallback wording, but it cannot authorize **View active run** or **Push now**.

### Native-shell live roster only

Each native window could publish its active chat/job IDs to the shell. This
gives good same-app navigation, but it misses browser tabs, a second Host
process, and any owner whose renderer disappeared while the Host job continued.
The roster is useful as a navigation index, never as execution authority.

### Host-authoritative admission plus shell navigation

This is the selected approach. Ensync Host is authoritative for which job owns
a canonical conversation workspace. The native shell is authoritative only for
which live window owns a shell-issued workspace identity and for focusing that
window. Neither layer substitutes for the other.

## Design

### 1. Canonical workspace-run admission

Before creating a runnable Host job, resolve an execution-scoped conversation
coordinate:

- local: canonical repository/common-Git identity plus the validated
  conversation workspace key;
- SSH: verified execution-target identity plus canonical remote project path
  when the current bridge can prove it, and the same conversation workspace
  key.

The coordinator admits at most one active job for that coordinate. Job start
returns one of three dispositions:

- `started`: this request became the owner;
- `reconnected`: the exact job ID and request hash already own the coordinate;
- `occupied`: a different running job owns it, so no new Host job or provider
  process was created.

Local `POST /api/chat/jobs` admission becomes asynchronous and non-blocking at
the workspace boundary. `ProjectIsolationService` first performs an exact
`tryAcquireOrDescribe` operation. A free coordinate returns a pre-acquired
lease that is passed into `ChatRunService` rather than acquired a second time;
an occupied coordinate returns the bounded owner record immediately rather
than polling. The Host durably registers the job before provider execution, and
any registration or workspace-preparation failure releases the pre-acquired
lease. This ordering makes the filesystem lease authoritative across Host
processes without creating a retained waiter job.

SSH jobs use the same Host-local admission contract for one verified target and
workspace key. The current one-shot remote bridge cannot authoritatively
inspect or control a job owned by a different Host process, so that case keeps
the existing remote serialization and exposes no View, Push, or cross-Host
Stop action.

The `occupied` result includes only bounded public ownership metadata: owner job
ID, provider, target kind, start time, provider-started state, steerable state,
an optional shell-issued native workspace identity, and an optional logical
turn ID when the owner is retained by this exact Host process. The turn ID is
live-memory-only: it is never written to the filesystem owner record or job
journal, never reaches a provider request, and is always `null` for a
cross-Host description. The result never includes a prompt, provider output,
attachment path, repository path, lease token, or raw request. Lookup is
possible only through the exact authenticated start request; there is no global
active-job listing.

The filesystem lease remains the cross-process safety boundary. Its owner
record gains only the bounded job/navigation identifiers needed to produce an
honest wait notice when another Host process wins the lease. Those identifiers
are hints outside the owning Host: they do not grant cancellation, steering, or
stale-lock deletion authority.

The owner mapping is journal-aware. A Host restart may restore a completed job
or mark an orphaned running job reconciliation-required, but it must never
restore an active ownership claim that could replay a prompt. Terminal jobs
release admission in a `finally` path after the existing worktree lease and
landing lifecycle complete.

### 2. Renderer queue behavior

The renderer checkpoints the user message before Host admission as it does
today. On `occupied`, it converts that message to the existing persistent FIFO
`queued` state instead of retaining a second pending in-flight job. Routing
preferences, project, target, attachments, predecessor turn, and stable message
identity remain snapshotted exactly as for a normal same-renderer queued send.

The conversation shows a compact active-run card with:

- factual owner provider and elapsed time;
- **View active run** only when an exact reachable native owner is verified;
- **Push now** only when the Host reports the exact owner job as steerable and
  all existing predecessor/project/target/provider checks pass;
- the existing two-step **Stop & send now** when steering is unavailable but
  the exact active run is controllable;
- plain copy explaining that the message remains queued when the owner cannot
  be reached or controlled.

No action is shown as available based solely on a saved snapshot, a job ID, a
PID, or a generic `running` state.

### 3. Exact native navigation

Native windows publish a bounded live roster entry to the main process:
shell-issued workspace ID, verified project ID/path, chat ID, and active Host
job ID. The main process accepts entries only from the authorized live
`webContents` that owns that workspace identity and removes them when the
window closes or replaces its entry. A waiting renderer may query only one
complete exact target; the shell returns a boolean and never exposes a global
roster. View, Push, and Stop controls remain absent until both the same-Host job
probe and this exact shell query succeed.

**View active run** sends the existing authorized focus IPC an exact workspace,
project, chat, and job target. The main process verifies the retained live
workspace and focuses its `BrowserWindow`, then asks that renderer to activate
the chat. The target renderer independently verifies that the project, chat,
and in-flight job still match before opening/unhiding the tab or pane. A stale
target fails without changing either window.

If the current renderer is the only surviving presentation of the exact owner
job, it uses the existing retained-job reconnect path rather than opening a new
job. Browser mode and an owner in another Host process state honestly that
window navigation is unavailable.

### 4. Cross-window message handoff and Push now

The active run's renderer remains the presentation owner until the turn reaches
a terminal state. A waiting renderer never steers another window's job directly
and then guesses how to update that window's transcript.

For a reachable native owner, the source hands the FIFO head to the target
renderer through authorized IPC using its stable message/turn IDs, exact owner
job ID, predecessor, snapshotted project/target/provider preferences, prompt,
and attachments. The target accepts the handoff only when all exact bindings
still match, persists it into its own FIFO first, and acknowledges that stable
message ID idempotently. Only after acknowledgment may the source mark its copy
as transferred and focus the owner.

`transferred` is a new persisted, non-executable user-message delivery state.
It remains visible in the source snapshot for auditability but is excluded from
FIFO draining, provider transcript execution, unread completion, and retry.
Recovery and account-sync merging treat the target owner's queued/active/
completed copy as stronger than a stale transferred source copy with the same
stable message ID.

The target then invokes the existing **Push now** path:

- Host-confirmed delivery promotes that message into the owner's logical turn
  and rebases only its immediate FIFO successor.
- A Host-proven rejection leaves it queued for ordinary post-turn execution.
- An ambiguous response removes it from automatic execution and marks it
  interrupted.

The stable handoff/message ID is also the steering idempotency key. Repeating an
acknowledged handoff or steering request cannot deliver the prompt twice;
reusing the ID with different content is a hard conflict.

Target persistence is strict and synchronous: a failed workspace commit cannot
ACK the source or invoke Push/Stop. If an ACK times out after the target may
have committed, the shell may redeliver only the original normalized request
for the same authenticated source, target, action, and content. The target's
local immutable tombstone acknowledges either a still-queued or already-
consumed duplicate without repeating Push/Stop, after which the source can
safely become `transferred`. A changed action, prompt, attachment, preference,
source, or target remains a hard conflict.

When live steering is unavailable, **Stop & send now** remains a distinct
two-step action performed by the active renderer. It records the existing
explicit approval before stopping and advances only the transferred FIFO head.
That approval travels only in the target-bound handoff payload; rejection or
timeout leaves the source FIFO byte-for-byte unchanged and unapproved. A plain
Stop never advances the queue.

### 5. Compatibility and failure handling

- A mixed-version Host that returns only `workspace_write_lock_waiting` keeps
  the existing safe wait/Stop behavior. The new controls remain absent and the
  UI asks for a full quit/reopen before relying on owner navigation.
- A legacy second job already waiting on a lease is never transferred until
  Host cancellation proves that no provider process started. An unknown or
  partially started waiter remains reconciliation-required and cannot be
  pushed automatically.
- If the owner finishes before **View active run**, the queued message remains
  in FIFO and normal success-only advancement applies.
- If the owner finishes during handoff, the target accepts the message as an
  ordinary queued turn; it never labels a new job as steering.
- If the owner window disappears after Host admission, the Host job continues
  detached. The current renderer may reconnect only through the exact job ID;
  otherwise it reports that the owner cannot be opened.
- An owner from another Host process can be named only with verified bounded
  metadata. It cannot be focused, steered, stopped, or reclaimed through the
  current Host.
- Cross-project, cross-target, cross-chat, stale-workspace, and mismatched-job
  handoffs fail closed before transferring message content.

## Provider scope

This feature does not add a new provider capability or relax routing rules.
Local Codex remains the only currently verified live-steering implementation.
Claude's measured stream-input behavior is FIFO rather than same-turn steering,
and SSH has no verified return channel, so both remain queue/stop-and-send only.
Future providers may expose **Push now** only after their dated capability
research and runtime contract prove same-turn delivery, rejection, ambiguity,
cancellation, subscription eligibility, and platform behavior.

## Testing

### Host

- Two different job IDs for one canonical workspace return `occupied`; the
  second provider never starts and no second job is journaled.
- Exact job ID plus request hash reconnects; a mismatched request conflicts.
- Different conversations in one repository remain concurrent.
- Repository aliases/symlinks resolve to one local coordinate; different
  repositories cannot collide on a reused workspace key.
- Terminal, cancelled, failed, and orphaned jobs release or invalidate
  admission without replay.
- Public occupied metadata excludes prompts, paths, attachments, tokens, and
  raw requests.
- Same-Host and cross-Host filesystem lease cases preserve cancellation,
  heartbeat, staleness, and non-stealing guarantees.

### Renderer and native shell

- `occupied` converts the new message to persistent FIFO state without a
  pending second job.
- **View active run** focuses the exact workspace and activates the exact chat;
  stale workspace/chat/job combinations fail without navigation.
- Roster publication is authorized, bounded, replaced atomically, and removed
  on close on both macOS and Windows.
- Cross-window handoff is idempotent and preserves prompt, attachments,
  routing preferences, predecessor, project, and target.
- Confirmed Push promotes one FIFO head; safe rejection keeps it queued;
  ambiguous delivery marks it interrupted; later FIFO entries never leak into
  the active turn.
- Claude, SSH, and non-steerable Codex show no Push action and preserve the
  two-step Stop & send flow.
- Owner completion, owner-window closure, renderer reload, Host restart,
  mixed-version fallback, and legacy lease-wait races remain non-replayable.
- Browser mode states navigation limits honestly and never simulates native
  focus or cross-window handoff.

## Documentation updates

`.relay/features/workspace-tabs.md` records the durable queue, navigation,
handoff, and Push rules. `.relay/architecture.md` needs no new boundary: Host
job admission remains Host-owned and native window focus remains shell-owned.
Implementation that changes provider capability facts must also update
`.relay/features/agent-routing.md` and `.relay/provider-api-research.md`; this
design intentionally does not change those facts.

## Out of scope

- A global active-job browser or prompt/output inspection surface.
- Steering Claude, SSH, or any provider without a verified same-turn contract.
- Force-reclaiming a live lease or cancelling a job owned by another Host.
- Cross-device window focus or cross-device message transfer.
- Merging or deleting duplicate saved conversation snapshots.

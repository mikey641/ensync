# Immediate Automatic Landing Rewrite

## Goal

Make concurrent Ensync chats safe and fast without allowing repository integration to keep a completed provider job in `Working`. Every chat keeps an isolated working copy. Successful work enters an automatic completion-order landing queue immediately, and all conflict handling happens outside the originating chat job.

## User decisions

- Keep the user-facing Git import, status, remote, and guarded push features.
- Replace Ensync's homegrown agent-workspace and automatic-landing internals.
- Automatic landing is always event-driven and begins immediately when a successful provider run has been durably saved.
- The first chat to finish is the first chat attempted for landing.
- Chats that finish while a landing is active form the next ordered train.
- Landing never asks for manual merge review.
- A difficult item must not keep later items or the originating chat stuck.
- Remove project-owned legacy coordination skill artifacts and redundant coordination prompt injection. Do not modify user-global Codex or Claude installations.

## Research and selected approach

The common open-source pattern is one Git worktree per agent followed by a separate integration phase. Vibe Kanban, dmux, and agent-worktree use that isolation boundary. Mergetrain adds a single ordered integration runner, exact input identities, combined validation, and recoverable queue state. Pact adds an automated Arbiter that accepts an agent-proposed conflict resolution only after a real test passes. Mergiraf improves deterministic merging by understanding source syntax.

Three approaches were considered:

1. Patch the current leases and auto-land timeouts. This is the smallest change, but it retains the architecture that already produced leaked workspace locks, hour-long conflict-agent waits, and code-destroying sweeps.
2. Replace Git worktrees with Jujutsu workspaces. Jujutsu's first-class conflicts and operation log are attractive, but the project still describes itself as experimental and documents Git interoperability and repository-feature gaps. It is too large a compatibility change for projects that users already operate with Git.
3. Keep Git compatibility while delegating worktree lifecycle and merging to the open-source `agent-worktree` CLI, and adopt Mergetrain's completion-order integration model plus Pact's test-gated Arbiter behavior. This is the selected approach. It preserves ordinary Git repositories, has macOS and Windows binaries through its npm distribution, and returns a bounded machine-readable result instead of leaving Ensync to infer merge state.

`agent-worktree` is pinned as a runtime tool. Ensync owns only provider routing, the completion-order queue, UI events, and subscription-backed conflict-agent selection. It no longer implements Git worktree creation, branch synchronization, merge cleanup, or merge-state recovery itself.

## Runtime architecture

### Provider job boundary

`ChatRunService` ends after four things: the provider process has terminated, its structured result has been parsed, changed files have been durably snapshotted on the conversation branch, and an eligible landing item has been enqueued. It does not await a repository lock, baseline merge, land verification, repair run, push, or conflict-resolution agent.

Saving the branch remains inside the job boundary because reporting success before preserving mutations risks data loss. Everything after preservation belongs to landing.

### Agent workspace adapter

A focused `AgentWorktreeClient` invokes the pinned `wt` executable with argument arrays and `shell: false`. It exposes small operations:

- create or locate the stable conversation worktree;
- report machine-readable status;
- synchronize a conversation worktree from its base;
- merge a completed conversation branch into the configured base;
- continue or abort tool-owned synchronization after automated resolution.

New workspaces use agent-worktree's storage and metadata. Existing `ensync/chat-*` branches and managed worktrees are discovered and adopted lazily so the migration cannot orphan completed work. Ensync keeps no renewable per-chat lock directories. Duplicate starts are rejected by the Host job registry before a provider process starts; the desktop Host remains a singleton authority for local execution.

The canonical checkout is never cleaned, reset, stashed, or force-updated. If an external user edit makes immediate local integration unsafe, landing uses an isolated integration worktree and retries without touching those bytes. Immediately before delegated publication it rechecks both the target SHA and canonical status; a moved or dirty target makes the train retry.

### Completion-order landing coordinator

The Host owns one `LandingCoordinator` per repository and repositories may integrate concurrently. Enqueue is event-driven; there is no polling interval or five-minute sweeper.

When idle, the coordinator begins the first item immediately. Items are ordered by the monotonic completion sequence assigned after their branch snapshot succeeds. Items that arrive while the coordinator is active become the next train in that order. A train records the exact base SHA and exact conversation branch SHAs before integration.

The implemented fast path is:

1. Ask agent-worktree to synchronize and merge each train item in order inside an isolated integration working copy.
2. Reject an unavailable input SHA, unmerged paths, committed conflict markers, a dirty canonical checkout, or a moved target ref.
3. Run `git diff --check` and the repository's optional bounded `land:quick` gate. If the script is absent, the dependency-free structural gate is sufficient; an unbounded full suite is never substituted.
4. Ask agent-worktree to publish the whole verified integration branch into the target once, then emit `landed` events for the contained items.

There is no artificial batching delay. A single completion starts at once. Several completions already waiting are integrated as one train so shared checks run once and the canonical ref advances once.

### Automated conflict resolution

If deterministic merging cannot resolve an item, the coordinator immediately starts a one-shot resolver through Ensync's existing subscription-authenticated provider adapter. It runs only in the isolated integration workspace, receives the base/left/right identities and bounded conflict paths, and cannot push, land, or access another checkout.

The proposed resolution is accepted only when conflict markers are gone and the structural and optional `land:quick` gates pass. The resolver gets a bounded time budget. If it cannot produce an acceptable result, that item moves to a retry lane with its branch intact and later compatible items continue in the same train. Retry-lane items are attempted automatically on Host startup and ahead of the next completion for that repository. The UI never requests manual merge review.

### Recovery

Landing state is separate from the chat-job journal and contains no prompts, provider output, or secrets. Each item stores repository identity, conversation branch, exact saved SHA, completion sequence, state, attempts, and last bounded error. Writes use the project's existing atomic primary/staging/backup pattern.

On Host startup, `integrating` items return to `queued`; the coordinator verifies the current target and each immutable saved SHA before doing anything. Missing SHAs are never guessed or replayed. Tool-owned integration worktrees are removed after each attempt, while the source conversation branches remain available.

### UI behavior

The provider message and completion notification appear as soon as the provider job, branch snapshot, and durable queue append finish. The queued notice is retained with the run, while subsequent landing is Host-owned background work and never reopens the completed chat. There is no `Needs merge review` state, no automatic-landing preference, and no spinner that treats repository integration as provider work. Stop affects only the active provider job; it does not cancel already-preserved landing work.

## Removed implementation

The rewrite removes:

- awaited auto-landing from `ChatRunService`;
- custom repository landing leases and renewable workspace-write lock directories;
- the periodic `scripts/auto-land*` sweeper;
- the old auto-land timeout and conflict/repair waits attached to chat jobs;
- branch-side-picking or force-merge behavior;
- the injected `[ENSYNC SAFE MULTI-AGENT v1]` prompt and provider coordination-policy metadata;
- the filesystem-polled active-edit overlap monitor, injected peer warning, and overlap banner;
- project-owned legacy coordination skill artifacts;
- redundant automatic-landing controls whose off state conflicts with the selected always-on behavior.

The reusable Ensync Auto Context skill remains because it is a product feature and carries provider-neutral continuity; user-global skills are untouched.

## Compatibility and safety

- Provider routing remains subscription-only and catalog-wide.
- Automatic fallback remains forbidden after observed or ambiguous mutation.
- Local macOS and Windows packages include the correct pinned agent-worktree binary; no global installation is required.
- Direct SSH execution keeps its existing narrow raw-Git worktree isolation without filesystem leases, heartbeat polling, or hidden snapshots. Remote automatic landing remains unavailable until the same pinned native integration engine can be verified on the worker.
- Existing chat branches remain recoverable and are never deleted during migration.
- No operation uses `-X ours`, `-X theirs`, forced ref updates, `git add -A` after a conflict, or destructive canonical-checkout cleanup.

## Verification

Tests prove that provider completion is not delayed by a never-resolving landing promise; success requires a durable exact-SHA enqueue; FIFO order follows branch-snapshot completion; arrivals during one train form the next train; dirty targets remain byte-for-byte unchanged; conflict items enter automatic retry without blocking compatible work; restart recovery neither duplicates nor loses landing; later chat commits cannot change an already queued snapshot; legacy branches remain discoverable; and macOS/Windows tool resolution chooses the correct packaged binary.

The complete release gate includes lint, TypeScript, Host tests, desktop tests, packaging checks, a production renderer build, a desktop Host smoke, public-site validation, and temporary-repository integration tests that apply multiple conversation worktrees in completion order.

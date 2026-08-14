# Cross-Conversation Edit Awareness Design

## Goal

Give Ensync conversations Anthropic-style awareness when another conversation is changing the same files, without preventing legitimate parallel work. The warning must be visible in the conversation, supplied to the coding agent at safe prompt boundaries, and backed by a serialized, freshly rechecked landing path.

## Product behavior

- Different conversations continue running concurrently in separate protected worktrees.
- Ensync warns only for exact repository-relative file overlap. Sharing a directory is not sufficient.
- A compact amber banner appears above the composer while an overlap is active. It names up to three paths, reports the remaining count, identifies a locally known conversation title when possible, and otherwise says “another Ensync conversation.”
- The banner explicitly says work can continue and that Ensync will recheck before landing.
- The warning clears when the path sets stop overlapping or the peer activity expires.
- The execution log retains structured detected and cleared notices so reconnecting windows recover the same state.
- An overlap that already exists before a provider starts is included in the provider's Ensync workspace-isolation preamble. A newly detected mid-turn overlap is shown immediately to the person and is included at the next Host-controlled provider prompt boundary: a subsequent conversation turn, conflict-resolution turn, or land-check repair turn. Ensync does not claim universal mid-turn steering because the supported CLIs do not all provide it.
- Warnings are advisory. Existing Git conflict checks and land verification remain authoritative.

## Active-edit records

Each local run owns one record under the repository's Git common directory:

`ensync/active-workspace-edits/<workspace-hash>.json`

The record contains a schema version, protected branch, job identifier, update timestamp, and a bounded sorted list of repository-relative paths. It never contains file contents, prompts, conversation text, credentials, or canonical absolute paths.

The Host writes records by atomic replacement. A lightweight poller refreshes the current run's paths and reads peer records. Records are removed during normal release and ignored after a conservative stale timeout following a crash. All paths are normalized to Git's forward-slash repository-relative representation before comparison, which keeps behavior identical on macOS and Windows.

The current run's path set is derived relative to a snapshot taken after workspace acquisition and before provider execution. The snapshot fingerprints initially dirty and untracked files so changing a file that was already dirty is still detectable. Deleted and renamed paths are represented by every affected repository path. Generated files under Git metadata and Ensync's private common-directory records never participate.

Polling and record failures are advisory failures: they emit at most one bounded diagnostic notice and never stop provider execution or mutate project files.

## Overlap calculation and lifecycle

The overlap monitor compares the current run's changed path set with every fresh peer record from the same Git common directory, excluding its own branch and job. Each peer produces a stable overlap identity and sorted intersecting path list.

The Host emits an event only when that peer's overlap state changes:

- `workspace_file_overlap_detected` includes the peer branch and complete bounded path list.
- `workspace_file_overlap_cleared` includes the peer branch and no active paths.

This transition model prevents one-second polling from flooding the job journal. On reconnect, the renderer reduces retained overlap events by peer branch to rebuild current active warnings. Multiple peers are combined into one banner while the execution panel preserves the individual Host notices.

Before provider launch and immediately before landing, Ensync also compares the conversation branch with other unlanded `ensync/chat-*` branches. This catches completed-but-unlanded work that has no live activity record. The UI copy distinguishes “is editing” from “has unlanded changes.”

## Agent advisory

The existing workspace-isolation preamble receives a bounded overlap section. It lists exact paths and instructs the agent to re-read affected files before changing them, preserve compatible work, and avoid accessing another worktree. It does not tell the agent to merge, push, land, or resolve another conversation's task.

The same section is recomputed for every new provider prompt. Conflict-resolution and land-check repair prompts receive the latest overlap state as well. Mid-turn delivery remains capability-specific and is not required for correctness; Ensync must not silently initiate an extra provider turn or spend subscription quota merely to deliver an advisory.

All locally executable catalog providers receive the preamble through the shared `ChatService` boundary. Discovery-only and unavailable providers start no run and therefore receive no advisory. SSH execution remains explicit: the current one-shot bridge has no live Host event channel and no remote landing operation, so this feature does not claim live remote warnings. A future remote implementation must place the same records and landing lease in the remote repository's Git common directory before advertising parity.

## Serialized landing

Every local explicit or automatic land acquires one renewable repository-scoped lease under:

`ensync/repository-land.lock/owner.json`

The lease is cross-process, cancellation-aware, atomically heartbeated, and conservatively reclaimed only after its owner is stale. A waiting automatic land emits one `repository_land_waiting` notice. Explicit API lands wait through the same coordinator.

After acquiring the lease, landing recomputes the canonical checkout state, exact overlap advisory, branch-ahead state, and `git merge-tree` conflict precheck. It never relies on data captured before it entered the queue. The lease remains held through the merge, repository `land:check`, rollback on failure, and final merge-head capture, then releases in a `finally` block.

The queue prevents two Hosts from mutating the shared checkout simultaneously. It does not block active provider work in protected worktrees and does not convert advisory file overlap into a refusal. A dirty shared checkout, a textual conflict, or failed semantic verification continues to fail closed under the existing rules.

## UI and persistence

`ChatExecutionEvent` notice payloads gain an optional structured overlap object with peer branch, state, source (`active` or `unlanded`), paths, and total count. Paths are bounded before journaling and rendering.

The renderer derives current overlap state from events rather than maintaining an unsynchronized second persistence store. The conversation banner is visible even when the CLI execution panel is collapsed. It uses `role="status"`, does not steal focus, wraps long paths, and works in light and dark themes. Clearing the last overlap removes the banner.

The Git workflow panel continues listing unlanded branches. It may display their overlap count when available, but adding branch-to-branch file detail to that modal is not required for this feature.

## Failure handling

- Malformed, oversized, self-authored, path-invalid, or stale activity records are ignored.
- Poll failures are deduplicated and surfaced as an advisory diagnostic; provider work continues.
- A lost activity-record heartbeat removes only the warning guarantee, never workspace isolation.
- A lost landing lease aborts before any new Git mutation. If loss is detected after a merge started, existing rollback and recovery behavior runs before reporting failure.
- Host or renderer restart recovers retained overlap events and discards stale peer records without touching worktrees or branches.
- Event and record limits prevent a generated-file storm from exhausting the job journal or UI.

## Test strategy

Host tests use temporary repositories and verify:

- exact-file intersections warn while shared directories do not;
- initially dirty files are detected after their contents change;
- create, modify, delete, and rename paths normalize consistently;
- malformed and stale records are ignored and normal release removes ownership;
- detected notices are deduplicated and cleared notices end the warning;
- preflight advisories cover active and completed-unlanded peer work;
- the shared provider preamble includes bounded paths without exposing peer worktree paths;
- two simultaneous land attempts serialize and the second rechecks the new `HEAD`;
- cancellation, lease loss, merge conflicts, and failed land checks leave work recoverable.

Renderer tests verify event reduction, reconnect recovery, multiple peers, accessible banner copy, path truncation, and removal after clear. The repository's full `land:check` remains the final integration gate.

## Non-goals

- Reserving or locking source files before editing.
- Blocking two conversations merely because they touch the same path.
- Reading or copying another conversation's uncommitted file contents.
- Inventing provider support for universal live mid-turn steering.
- Automatically choosing one conversation's version during a conflict.
- Adding remote SSH claims before the remote bridge supports live records and landing.

---
name: Git workflows
description: Real repository import, remote verification, status, and guarded push behavior.
---

# Git workflows

Ensync Host owns Git operations for the focused local project. The browser never builds a shell command and never collects or stores a Git service token. The host launches the fixed `git` executable with a separate argument array and relies on the computer's existing Git credential helper or SSH agent.

## Agent workspaces

Coding agents do not mutate the focused shared checkout. For each stable workspace/conversation key, Ensync Host creates or reuses a durable `ensync/chat-…` branch in a managed Git worktree, maps a selected repository subdirectory to the same location inside that worktree, and reports the protected identity in the conversation. Git before/after continuation status is read from that worktree. The selected canonical path remains the project identity for navigation and explicit user Git operations.

The renderer persists an explicit `conversation:<chat-id>` agent-workspace key on the conversation before starting local or SSH execution. Chats already bound to a worktree under the former object-coerced key keep that exact key so an upgrade cannot orphan their branch or continuation state. A request with no key indicates a mixed-version client and fails before provider execution with an actionable quit-and-reopen upgrade error; malformed supplied keys still fail validation.

One renewable write lease in the repository's shared Git directory covers each conversation workspace for the entire provider run across local windows and Host processes. Different chats use different worktrees and run concurrently even inside the same repository; only duplicate runs targeting the same conversation workspace wait before provider start. For a first-time conversation, a dirty shared checkout is captured through a temporary private index and synthetic transport commit, used to seed the protected worktree, then immediately mixed-reset to the real shared `HEAD`; the inherited tracked and non-ignored untracked files therefore remain uncommitted inside the protected workspace. The synthetic commit is not retained on the conversation branch, and the shared checkout, index, branch, and history remain untouched. Ensync never cleans, stashes, commits into user history, deletes, or auto-merges those changes. Managed worktrees and branches survive run completion and failure so the user can verify and reconcile them before any future explicit cleanup workflow.

When a reused conversation branch conflicts with a newer shared-checkout baseline, admission aborts that merge and verifies that the exact protected worktree is clean, has no unmerged index entries, and has no merge in progress. The conversation then starts normally with bounded conflict-path metadata in both the renderer notice and provider preamble. Ensync never asks another conversation to enter the protected worktree. After a successful turn, the ordinary guarded landing pipeline retries the latest baseline merge inside the owning worktree, delegates only the in-progress conflict resolution, verifies the concluded merge and repository land gate, then serializes the land through the repository lease. If abort recovery cannot prove a clean worktree, admission still fails closed.

## Cross-conversation edit awareness

Local protected workspaces publish bounded, content-free active-edit records under Git's shared common directory. Ensync compares exact normalized repository-relative paths across conversations, shows a non-blocking warning in every affected conversation, and supplies the same advisory to providers at Host-controlled prompt boundaries. Sharing only a directory never warns. Activity records are atomic, renewable, cross-process, removed on release, and ignored when stale; failures in this advisory channel never stop isolated provider work.

Periodic overlap inspection keeps one Git scan active and coalesces any number of timer or explicit refresh requests into at most one trailing scan. Requests arriving during the trailing scan share its completion and cannot extend the drain; a failed active scan still consumes an already requested bounded retry. Stopping a session suppresses pending trailing work, waits only for the active scan, and removes the owned activity record. A slow repository therefore cannot accumulate an unbounded advisory queue that delays workspace-lease release or leaves a completed provider run displayed as active.

Before a provider starts and immediately before a land, Ensync also checks completed-but-unlanded `ensync/chat-*` branches so a finished peer cannot disappear from overlap awareness. The provider is told to re-read and preserve compatible work, never to access another worktree or perform the Host-owned push/land. Mid-turn UI warnings are immediate, but Ensync does not claim universal mid-turn agent delivery where a provider CLI has no steering channel. Remote SSH remains unsupported for live overlap warnings until its one-shot bridge gains remote activity records and a remote landing operation.

All local explicit and automatic land operations serialize through one renewable repository-scoped lease in Git's common directory. After entering that queue, the land operation freshly rechecks the checkout, branch, overlaps, merge conflicts, and repository land gate. File overlap stays advisory; dirty shared state, Git conflicts, and semantic verification failures continue to fail closed. Automatic landing is on by default and can be disabled host-wide with `ENSYNC_AUTO_LAND=0` (or the `autoLandAgentWork` host option). It is also a user preference: the renderer's Automatic landing settings toggle (on by default, persisted with the workspace snapshot) travels with each local run request as its optional boolean `autoLand` field, and `autoLand: false` keeps that run's branch unlanded for explicit review. Because the shared Host daemon outlives any one window, the preference is carried per request rather than stored host-side; a request can opt out of landing but never re-enable it when the host-wide switch has it off.

## Repository creation

Ensync isolates every local agent run in a Git worktree, so a focused project that is not inside a repository cannot host one. Rather than refusing that project, Ensync Host creates what the run needs: `git init --initial-branch=main` in the project folder, then one `Initial commit` holding the files already in it. A folder that is already inside a repository is never re-initialized; a repository that exists with no commit gets only the missing first commit, made at that repository's own root so a partial tree is never committed into it. The commit uses the computer's configured Git identity and falls back to an Ensync identity only when Git has none. Nothing is pushed.

Creation runs automatically before local isolation, and the Git panel also offers it explicitly whenever status reports the focused project outside a repository. A host can keep the previous fail-closed behavior with `ENSYNC_AUTO_INIT_GIT=0` (or the `autoInitializeGitRepositories` host option); a non-Git project then refuses local agent execution with an explanation instead. A home directory is always refused as too broad to become one project repository, and remote SSH execution still requires a repository that already exists on the remote.

## Repository import

- Import requires an allowlisted HTTP, HTTPS, SSH, or Git-protocol URL, a strict `user@host:path` SSH location, or an absolute local repository path.
- Relative repository paths, credentials embedded in HTTP URLs, `file::`, `ext::`, unknown external remote helpers, control characters, and option-like locations are rejected before Git starts.
- The destination must be an absolute path for a new folder whose parent exists. Ensync canonicalizes the parent, rejects filesystem roots and existing destinations, and enforces configured host project roots.
- A successful clone is inspected by Ensync Host and becomes the focused project using the canonical path returned by the filesystem.

## Status and connection

Status is derived from real Git commands and reports the repository root, checked-out branch or detached state, configured upstream, exact ahead/behind counts when Git has them, dirty state, changed-file count, and configured fetch/push remotes. The production branch is discovered from the selected remote's symbolic HEAD, then `main` or `master` remote refs; otherwise it remains unknown until the user supplies it.

Remote verification runs `git ls-remote --symref` non-interactively against the selected configured remote. It uses only credentials already available to Git. Ensync reports the connection as verified only after that command succeeds. Before verification or push, every configured URL for the selected remote is checked against the same location allowlist so a repository-configured external helper cannot execute.

## Push policy

The default mode pushes the checked-out non-production branch to the same branch name on the selected remote and sets its upstream. If the checked-out branch is the discovered production branch, safe mode refuses the push and asks the user to switch to a feature branch or use the guarded production flow.

Direct production push sends the current commit to the chosen production branch without force. It requires all of the following in both UI and host request:

1. Explicit production mode.
2. A valid production branch.
3. The server-side `allowProduction` flag.
4. The exact typed confirmation `PUSH TO <branch>`.

Push means a Git branch update, not a guaranteed deployment. It may trigger deployment only when the remote repository is configured to deploy from that branch.

Tests must use temporary local repositories and bare remotes. They must never push a real external repository.

# Immediate Automatic Landing Rewrite Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ensync's awaited homegrown landing pipeline with immediate completion-order background integration delegated to `agent-worktree`, while removing redundant coordination prompts and legacy project-owned skill artifacts.

**Architecture:** Provider jobs preserve their branch, enqueue one immutable landing item, and complete without awaiting integration. A repository-scoped coordinator creates a tool-owned integration worktree, applies currently queued item SHAs in completion order, resolves genuine conflicts with a bounded subscription-backed agent, and publishes through agent-worktree while later chats remain independent.

**Tech Stack:** Node.js ESM, Node test runner, React/TypeScript, Electron, Git, `agent-worktree` 0.13.6 native CLI.

## Global Constraints

- Preserve the selected project as the hard context boundary.
- Preserve subscription-only provider routing and the pre-mutation safe-fallback rule.
- Preserve macOS and Windows as equal desktop targets.
- Never run providers in the canonical checkout.
- Never use side-picking merge strategies, forced ref updates, or destructive checkout cleanup.
- A provider job must not await repository integration after its mutations have been durably saved.
- Automatic landing has no user-off switch and begins immediately without polling.
- A failed landing item remains recoverable and cannot block compatible later items.
- Keep `skills/ensync-auto-context/`; remove only project-owned legacy coordination skills and redundant prompt artifacts.

---

### Task 1: Package and resolve the agent-worktree runtime

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `host/agent-worktree-client.mjs`
- Create: `host/agent-worktree-client.test.mjs`
- Create: `scripts/stage-agent-worktree.mjs`
- Modify: `desktop/scripts/package-native.mjs`
- Modify: `desktop/package.json`
- Modify: `scripts/install-app.mjs`

**Interfaces:**
- Produces: `resolveAgentWorktreeExecutable(options): Promise<string>`.
- Produces: `AgentWorktreeClient` with `list(repositoryPath)`, `create(input)`, `status(worktreePath)`, `sync(input)`, `continueSync(input)`, `abortSync(input)`, and `merge(input)`.
- Every operation returns bounded structured data and uses supervised argument-array process spawning with `shell: false`.

- [ ] **Step 1: Write failing executable-resolution and command-contract tests**

  Test source-mode resolution through `node_modules/.bin/wt`, packaged resolution through the staged native resource, rejection of a missing or unpinned executable, fixed `AGENT_WORKTREE_DIR`, JSON parsing for `wt ls --json`/`wt status --json`, and bounded process-tree shutdown.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `node --test host/agent-worktree-client.test.mjs`

  Expected: failure because `host/agent-worktree-client.mjs` does not exist.

- [ ] **Step 3: Add the pinned dependency and minimal client**

  Run: `npm install --save-exact agent-worktree@0.13.6`

  Implement the tested client. Never pass user text through a shell. Limit captured stdout/stderr, supervise the native process tree through close, and let the integrator inspect Git's actual unmerged state after a failed sync.

- [ ] **Step 4: Stage the correct native binary for source installs and target-native releases**

  `scripts/stage-agent-worktree.mjs` resolves the npm optional package for `process.platform`/`process.arch`, copies only its executable into a supplied tools directory, and preserves executable mode on POSIX. Wire native packaging to stage `desktop/build/tools/wt` before electron-builder and add that directory to `extraResources`. Wire `install-app.mjs` to copy the same staged directory into `Contents/Resources/tools` before signing.

- [ ] **Step 5: Run focused and packaging tests**

  Run: `node --test host/agent-worktree-client.test.mjs desktop/test/*.test.mjs`

  Expected: all tests pass and the packaging manifest contains the platform tool resource.

- [ ] **Step 6: Commit**

  Run: `git add package.json package-lock.json host/agent-worktree-client.mjs host/agent-worktree-client.test.mjs scripts/stage-agent-worktree.mjs desktop/scripts/package-native.mjs desktop/package.json scripts/install-app.mjs && git commit -m "build: package agent-worktree runtime"`

### Task 2: Add a durable completion-order landing queue

**Files:**
- Create: `host/landing-journal.mjs`
- Create: `host/landing-journal.test.mjs`
- Create: `host/landing-coordinator.mjs`
- Create: `host/landing-coordinator.test.mjs`

**Interfaces:**
- Produces: `LandingJournal.load()`, `LandingJournal.enqueue(input)`, and `LandingJournal.transition(id, expectedState, nextState, patch)` using atomic primary/staging/backup writes.
- Produces: `LandingCoordinator.enqueue(input): Promise<LandingItem>` and `LandingCoordinator.start(): void`.
- `LandingItem` contains only `id`, `repositoryPath`, `projectPath`, `workspacePath`, `branch`, `savedSha`, `provider`, `completionSequence`, `state`, `attempts`, timestamps, and a bounded error.

- [ ] **Step 1: Write failing journal tests**

  Cover checksum validation, staging recovery, monotonic completion sequence, omission of prompts/provider output, compare-and-transition semantics, and recovery of `integrating` to `queued` after restart.

- [ ] **Step 2: Run the journal test and verify RED**

  Run: `node --test host/landing-journal.test.mjs`

  Expected: module-not-found failure.

- [ ] **Step 3: Implement the atomic journal and verify GREEN**

  Reuse the existing workspace persistence envelope pattern without sharing its storage key or payload. Serialize writes inside the process and cap retained terminal entries.

  Run: `node --test host/landing-journal.test.mjs`

- [ ] **Step 4: Write failing coordinator ordering tests**

  Use an injected `integrate(train)` fake to prove: idle enqueue starts on the next microtask; a provider caller never awaits `integrate`; completion sequence controls FIFO; arrivals during an active train form the next train; repositories run concurrently; one rejected item moves to retry without blocking compatible items; and `start()` resumes journaled entries exactly once.

- [ ] **Step 5: Implement the minimal coordinator and verify GREEN**

  The coordinator owns one promise chain per canonical repository. It never uses polling or an unbounded wait. Integration errors become state transitions and bounded notices rather than rejected background promises.

  Run: `node --test host/landing-coordinator.test.mjs host/landing-journal.test.mjs`

- [ ] **Step 6: Commit**

  Run: `git add host/landing-journal.mjs host/landing-journal.test.mjs host/landing-coordinator.mjs host/landing-coordinator.test.mjs && git commit -m "feat: add completion-order landing queue"`

### Task 3: Build agent-worktree train integration

**Files:**
- Create: `host/landing-integrator.mjs`
- Create: `host/landing-integrator.test.mjs`

**Interfaces:**
- Consumes: `AgentWorktreeClient` and immutable `LandingItem.savedSha` values.
- Produces: `LandingIntegrator.integrate(train, options): Promise<{ landedIds: string[], retryIds: string[], head: string | null }>`.
- Produces: bounded conflict details passed to `options.resolveConflict(details)`.

- [ ] **Step 1: Write failing fast-path integration tests**

  In temporary real Git repositories, prove one item lands, several items apply in completion order, the target is updated once per train, moved item SHAs are rejected, a dirty canonical checkout is unchanged, and no side-picking/force arguments reach the tool client.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `node --test host/landing-integrator.test.mjs`

  Expected: module-not-found failure.

- [ ] **Step 3: Implement isolated train assembly**

  Create a short-lived `ensync/landing-*` agent-worktree based on the captured target. Apply each verified item via `wt sync --from <immutable-item-ref>` in order, run dependency-free structural/ancestry checks without repository scripts, and publish via `wt merge --into <target> --skip-hooks`. Keep source chat worktrees untouched.

- [ ] **Step 4: Write conflict and retry tests**

  Prove deterministic conflicts call the injected resolver once; accepted resolutions must remove unmerged entries, preserve target ancestry, and leave non-conflict files unchanged; rejected/timed-out resolution returns only that item to retry; compatible later items are rebuilt and land; and tool-owned sync is aborted before reuse after a failed resolver.

- [ ] **Step 5: Implement bounded automated resolution**

  Do not add a manual-review disposition. A failed item returns to retry with its immutable source branch intact. Never accept a conflict merely because the resolver process exited zero.

- [ ] **Step 6: Verify and commit**

  Run: `node --test host/landing-integrator.test.mjs host/agent-worktree-client.test.mjs`

  Run: `git add host/landing-integrator.mjs host/landing-integrator.test.mjs host/agent-worktree-client.mjs host/agent-worktree-client.test.mjs && git commit -m "feat: integrate completion-order trains"`

### Task 4: Detach landing from provider jobs

**Files:**
- Modify: `host/chat.mjs`
- Modify: `host/chat.test.mjs`
- Modify: `host/chat-jobs.mjs`
- Modify: `host/chat-jobs.test.mjs`
- Modify: `host/server.mjs`
- Modify: `host/server-integrations.test.mjs`

**Interfaces:**
- `ChatRunService` consumes `landingCoordinator` and exposes a bounded `resolveLandingConflict(details, options)` entry point using existing subscription-authenticated runners.
- Successful local runs enqueue after `commitAgentWork` returns an exact SHA.
- Chat jobs become terminal without awaiting any integration promise.

- [ ] **Step 1: Replace the hanging-auto-land regression with a stricter failing test**

  Inject an integration promise that never settles. Assert the provider result, terminal job state, subscriber end, and queued next same-chat message all complete while landing remains active. Assert enqueue occurs only after the exact saved SHA is known.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test --test-name-pattern='landing|provider completion' host/chat.test.mjs host/chat-jobs.test.mjs`

  Expected: the current run remains pending because `#autoLandAfterRun` is awaited.

- [ ] **Step 3: Remove awaited auto-land fields and wire enqueue**

  Delete `#autoLandAfterRun`, `autoLandWorkspace`, `autoLandTimeoutMs`, land-signal coupling, and post-provider repository waits from `ChatRunService`. Keep branch snapshot failure attached to the run because unsaved mutations cannot be declared durable. Enqueue successful saved work and return.

- [ ] **Step 4: Wire one coordinator into the Host**

  Construct the journal, agent-worktree client, integrator, and coordinator once in `server.mjs`; call `start()` during Host startup; route bounded landing events into the owning job event stream when it still exists without changing that job's terminal state.

- [ ] **Step 5: Verify and commit**

  Run: `node --test host/chat.test.mjs host/chat-jobs.test.mjs host/server-integrations.test.mjs host/landing-*.test.mjs`

  Run: `git add host/chat.mjs host/chat.test.mjs host/chat-jobs.mjs host/chat-jobs.test.mjs host/server.mjs host/server-integrations.test.mjs && git commit -m "fix: complete chats before automatic landing"`

### Task 5: Remove legacy landing and lock machinery

**Files:**
- Delete: `host/auto-land.mjs`
- Delete: `host/auto-land.test.mjs`
- Delete: `host/repository-land-lease.mjs`
- Delete: `host/repository-land-lease.test.mjs`
- Delete: `scripts/auto-land.mjs`
- Delete: `scripts/auto-land-all.sh`
- Modify: `host/project-isolation.mjs`
- Modify: `host/project-isolation.test.mjs`
- Modify: `host/git.mjs`
- Modify: `host/git.test.mjs`
- Modify: `host/server.mjs`
- Modify: `host/server-integrations.test.mjs`

**Interfaces:**
- Project isolation creates/adopts chat worktrees through `AgentWorktreeClient` and retains only process-local duplicate-run ownership supplied by the Host job registry.
- Explicit Land enqueues the exact selected branch SHA through `LandingCoordinator`; it does not run a second merge implementation.

- [ ] **Step 1: Write failing tests for lock-free admission and explicit landing delegation**

  Assert no `.git/ensync/workspace-write-locks` or repository-land lease paths are created, separate chats run concurrently, an identical active chat is rejected by job ownership, a restarted Host can adopt a legacy `ensync/chat-*` worktree, and the HTTP Land action enqueues instead of merging inline.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test host/project-isolation.test.mjs host/git.test.mjs host/server-integrations.test.mjs`

- [ ] **Step 3: Replace worktree lifecycle calls and delete leases**

  Retain canonical-path validation, repository URL safety, stable conversation keys, subdirectory mapping, and non-destructive legacy discovery. Delete heartbeat, stale-lock quarantine, lock polling, repository land leasing, baseline merge state, and stranded-lock recovery. New worktree creation that cannot safely inherit a dirty canonical checkout fails before provider start with bounded actionable output; it never synthesizes hidden history.

- [ ] **Step 4: Route explicit landing through the coordinator and delete old modules/scripts**

  Preserve Git import/status/remote/push APIs. Remove only the duplicate conversation-landing implementation and periodic sweep. Remove package/test references to deleted files.

- [ ] **Step 5: Verify and commit**

  Run: `node --test host/project-isolation.test.mjs host/git.test.mjs host/server-integrations.test.mjs host/landing-*.test.mjs`

  Run: `git add -A host scripts package.json && git commit -m "refactor: delegate workspace integration"`

### Task 6: Remove redundant prompts, skills, and landing controls

**Files:**
- Delete: `host/multi-agent-prompt.mjs`
- Delete: `host/multi-agent-prompt.d.mts`
- Delete: `host/multi-agent-prompt.test.mjs`
- Delete: `host/workspace-overlap.mjs`
- Delete: `host/workspace-overlap.test.mjs`
- Delete: `host/workspace-overlap-ui.test.mjs`
- Delete: `src/lib/workspaceOverlap.mjs`
- Delete: `src/lib/workspaceOverlap.d.mts`
- Modify: `host/provider-runner-contract.mjs`
- Modify: `host/provider-runner-contract.test.mjs`
- Modify: `host/providers.mjs`
- Modify: `host/chat.mjs`
- Modify: `src/lib/autoContextPrompt.mjs`
- Modify: `src/types.ts`
- Modify: `src/data.ts`
- Modify: `src/lib/ensyncHost.ts`
- Modify: `src/App.tsx`
- Modify: relevant renderer tests
- Delete: project-owned legacy coordination skill directories

**Interfaces:**
- Provider prompts contain only user text, verified project isolation context, and enabled Auto Context continuity.
- Provider catalog entries no longer expose `agentCoordination` metadata.
- Chat requests no longer carry `autoLand`; successful local coding work always enqueues.

- [ ] **Step 1: Change prompt/catalog/UI tests first**

  Assert the safe multi-agent marker and bundled coordination policy are absent, ordinary user marker-shaped text is unchanged, Auto Context budgeting no longer includes that envelope, the automatic-landing settings control is absent, and request serialization omits `autoLand`.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test host/multi-agent-prompt.test.mjs host/provider-runner-contract.test.mjs host/chat.test.mjs host/auto-context-fallback.test.mjs host/chat-preferences.test.mjs`

- [ ] **Step 3: Remove the redundant runtime and UI surfaces**

  Delete the wrapper and policy metadata, pass the isolated/Auto Context prompt directly, remove the landing preference and request field, and remove only the project-owned legacy coordination skill directories. Preserve `skills/ensync-auto-context/` and all user-global files.

- [ ] **Step 4: Verify active code has no stale coupling**

  Run: `test -z "$(rg -n 'ENSYNC SAFE MULTI-AGENT|ENSYNC_AGENT_COORDINATION_POLICY|withEnsyncMultiAgentInstructions|autoLand' host src desktop package.json || true)"`

  Run: `test -f skills/ensync-auto-context/SKILL.md`

- [ ] **Step 5: Commit**

  Run: `git add -A && git commit -m "refactor: remove redundant agent workflow controls"`

### Task 7: Update durable project documentation and shared memory

**Files:**
- Modify: `.ensync/architecture.md`
- Modify: `.ensync/features/git-workflows.md`
- Modify: `.ensync/features/agent-routing.md`
- Modify: `.ensync/features/auto-context-skill.md`
- Modify: `.ensync/features/remote-runtime.md`
- Modify: `README.md`
- Modify: `/Users/mikeyhasson/.claude/projects/-Users-mikeyhasson-dev-ensync/memory/git-workflows.md`
- Create or update: `/Users/mikeyhasson/.claude/projects/-Users-mikeyhasson-dev-ensync/memory/immediate-background-landing.md`
- Modify: `/Users/mikeyhasson/.claude/projects/-Users-mikeyhasson-dev-ensync/memory/MEMORY.md`

**Interfaces:**
- Durable docs describe agent-worktree ownership, completion-order landing, provider/landing state separation, automatic retry, and the migration boundary.

- [ ] **Step 1: Remove superseded lock/lease/awaited-auto-land claims**

  Update only the focused feature documents. Keep historical incident memories but mark their old operational remedies superseded by the new architecture.

- [ ] **Step 2: Write one focused shared-memory topic**

  Use Claude Code YAML frontmatter with `node_type: memory`, `type: project`, and the current modified timestamp. Record durable rules and failure-prevention guidance, not task logs.

- [ ] **Step 3: Check documentation consistency and commit repository docs**

  Run: `rg -n 'workspace-write-locks|repository landing lease|auto_land_timed_out|Automatic landing settings' .ensync README.md`

  Expected: no active claim that removed machinery still exists.

  Run: `git add .ensync README.md && git commit -m "docs: record background landing architecture"`

### Task 8: Whole-system verification and installed-app handoff

**Files:**
- Verify: all changed files.

**Interfaces:**
- Produces: fresh evidence for source, packaging, migration, and native install behavior.

- [ ] **Step 1: Run focused end-to-end concurrency tests**

  Run: `node --test host/agent-worktree-client.test.mjs host/landing-journal.test.mjs host/landing-coordinator.test.mjs host/landing-integrator.test.mjs host/chat.test.mjs host/chat-jobs.test.mjs host/project-isolation.test.mjs host/server-integrations.test.mjs`

- [ ] **Step 2: Run the full repository gate**

  Run: `npm run land:check`

  Expected: lint, TypeScript, Host tests, and desktop tests pass with zero failures.

- [ ] **Step 3: Verify requirements against the final diff**

  Run: `git diff --check && git status --short && git diff --stat HEAD~7..HEAD`

  Confirm provider jobs do not await landing, enqueue is immediate and FIFO by completion, conflicts auto-retry without manual review, old leases/sweeps/prompts/preferences are absent, Git UI remains, and Auto Context remains.

- [ ] **Step 4: Install and verify the local macOS app without killing the Host daemon**

  From a clean merged `main`, run: `node scripts/install-app.mjs && codesign --verify --strict /Applications/Ensync.app`

  Relaunch only the UI through LaunchServices after confirming the detached Host has no active children that would be disrupted. Verify the installed Host and staged `wt` binary hashes match source artifacts.

- [ ] **Step 5: Commit any verification-only corrections**

  If verification required source changes, repeat the focused and full gates before committing them. Do not create an empty verification commit.

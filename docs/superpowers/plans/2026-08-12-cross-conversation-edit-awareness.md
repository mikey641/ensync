# Cross-Conversation Edit Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn people and agents when local Ensync conversations change the same exact files, and serialize every local landing operation through a freshly checked cross-process repository lease.

**Architecture:** A Host-owned `WorkspaceOverlapMonitor` fingerprints each protected worktree at run admission, publishes bounded path-only activity records in Git's common directory, and emits transition events for intersecting peer records and unlanded branches. The shared chat prompt wrapper receives the current advisory, while a pure renderer reducer turns retained events into an accessible banner. `landAgentBranch` acquires a repository-wide filesystem lease before it reads or mutates the canonical checkout, so explicit and automatic lands share one queue.

**Tech Stack:** Node.js 22 ESM, Git CLI argument arrays, React 19, TypeScript, Node's built-in test runner, CSS.

## Global Constraints

- Exact repository-relative file matches warn; directory-only overlap does not.
- Warnings remain non-blocking and never copy peer file contents.
- Activity metadata lives only in Git's common directory and is atomically replaced.
- Provider advisories are guaranteed only at Host-controlled prompt boundaries; no extra subscription turn is created.
- Every local land is serialized across Host processes and reruns its checks after lease acquisition.
- macOS and Windows path behavior is equal; comparisons use normalized Git forward-slash paths.
- Remote SSH remains explicitly unsupported until its bridge has equivalent remote records and landing.

---

### Task 1: Active workspace overlap monitor

**Files:**
- Create: `host/workspace-overlap.mjs`
- Create: `host/workspace-overlap.test.mjs`
- Modify: `host/project-isolation.mjs`

**Interfaces:**
- Consumes: protected workspace objects containing `repositoryPath`, `branch`, `shared.repositoryPath`, and new `commonGitDirectory`.
- Produces: `WorkspaceOverlapMonitor.start(workspace, { jobId, signal, onEvent }): Promise<WorkspaceOverlapSession>` where a session exposes `current(): WorkspaceOverlap[]`, `refresh(): Promise<WorkspaceOverlap[]>`, and `stop(): Promise<void>`.
- Produces: `WorkspaceOverlapMonitor.inspect(workspace): Promise<WorkspaceOverlap[]>` for prompt and landing preflight.

- [ ] **Step 1: Write failing overlap tests**

```js
test('warns only when active conversations change the exact same path', async () => {
  const first = await monitor.start(firstWorkspace, { jobId: 'job-first', onEvent: event => firstEvents.push(event) })
  const second = await monitor.start(secondWorkspace, { jobId: 'job-second', onEvent: event => secondEvents.push(event) })
  await writeFile(join(firstWorkspace.repositoryPath, 'src/a.ts'), 'first\n')
  await writeFile(join(secondWorkspace.repositoryPath, 'src/b.ts'), 'second\n')
  await Promise.all([first.refresh(), second.refresh()])
  assert.equal(firstEvents.some(event => event.code === 'workspace_file_overlap_detected'), false)
  await writeFile(join(secondWorkspace.repositoryPath, 'src/a.ts'), 'second overlap\n')
  await Promise.all([first.refresh(), second.refresh(), first.refresh()])
  assert.deepEqual(firstEvents.at(-1).overlap.paths, ['src/a.ts'])
})
```

Add separate cases for initially dirty content changes, delete/rename normalization, malformed/stale/self records, deduplicated events, cleared events, bounded paths, and record removal.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test host/workspace-overlap.test.mjs`

Expected: failure because `WorkspaceOverlapMonitor` does not exist.

- [ ] **Step 3: Expose the Git common directory on protected workspaces**

Add `commonGitDirectory: repository.commonGitDirectory` to the private workspace object returned by `ProjectIsolationService`. Keep it out of `publicWorkspace` so renderer/API output does not expose Git internals.

- [ ] **Step 4: Implement the monitor minimally**

Implement atomic JSON replacement, bounded schema validation, cross-platform Git-path normalization, workspace snapshot fingerprints, `git status --porcelain=v1 -z`, active-record intersection, unlanded-branch comparison, transition deduplication, polling, staleness, and cleanup. Use dependency-injected clock/timers/Git runner in tests.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test host/workspace-overlap.test.mjs host/project-isolation.test.mjs`

Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit**

```bash
git add host/workspace-overlap.mjs host/workspace-overlap.test.mjs host/project-isolation.mjs
git commit -m "feat: track cross-conversation file overlap"
```

### Task 2: Provider context and overlap event lifecycle

**Files:**
- Modify: `host/chat.mjs`
- Modify: `host/chat.test.mjs`
- Modify: `host/auto-land.mjs`
- Modify: `host/auto-land.test.mjs`
- Modify: `host/server.mjs`

**Interfaces:**
- Consumes: `WorkspaceOverlapMonitor` from Task 1.
- Produces: `workspaceOverlapPrompt(overlaps): string` and structured notice events with `overlap: { peerBranch, state, source, paths, totalCount }`.

- [ ] **Step 1: Write failing provider-context tests**

```js
test('all local providers receive exact overlap paths in the isolation preamble', async () => {
  overlapMonitor.inspect = async () => [{ peerBranch: 'ensync/chat-peer', source: 'unlanded', paths: ['src/App.tsx'], totalCount: 1 }]
  await service.run(request, options)
  assert.match(seenPrompt, /another Ensync conversation/i)
  assert.match(seenPrompt, /src\/App\.tsx/)
  assert.doesNotMatch(seenPrompt, /peer worktree path/)
})
```

Add cases proving live detected/cleared events reach `onEvent`, monitor cleanup runs on success/failure/cancellation, conflict and repair prompts include current overlaps, and no extra provider run is created for a mid-turn warning.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test host/chat.test.mjs host/auto-land.test.mjs`

Expected: the new assertions fail because chat execution does not inspect or start overlap monitoring.

- [ ] **Step 3: Wire one shared monitor through the Host**

Construct `WorkspaceOverlapMonitor` in `createEnsyncHost`, inject it into `ChatRunService`, inspect before building `executionRequest`, start live monitoring before provider launch, and always stop it in the existing outer `finally` block.

- [ ] **Step 4: Add bounded prompt and event formatting**

Format at most three visible paths plus a remaining count in human notices, retain the bounded complete list in the structured payload, and add an isolation-preamble section instructing the agent to re-read and preserve compatible work without opening another worktree.

- [ ] **Step 5: Recompute overlap at Host-controlled repair boundaries**

Pass the latest monitor state into `conflictResolutionPrompt` and `landCheckRepairPrompt`. Do not steer providers or create a new turn solely for an advisory.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test host/chat.test.mjs host/auto-land.test.mjs host/workspace-overlap.test.mjs`

Expected: all tests pass with zero failures.

- [ ] **Step 7: Commit**

```bash
git add host/chat.mjs host/chat.test.mjs host/auto-land.mjs host/auto-land.test.mjs host/server.mjs
git commit -m "feat: surface overlap warnings to agents"
```

### Task 3: Repository-wide landing queue

**Files:**
- Create: `host/repository-land-lease.mjs`
- Create: `host/repository-land-lease.test.mjs`
- Modify: `host/git.mjs`
- Modify: `host/git.test.mjs`
- Modify: `host/auto-land.mjs`
- Modify: `host/auto-land.test.mjs`

**Interfaces:**
- Produces: `withRepositoryLandLease(commonGitDirectory, callback, options): Promise<T>`.
- `options` supports `signal`, `onWait`, injectable clock/UUID/timers, and lock timing for deterministic tests.
- `landAgentBranch(input, options)` continues returning the existing result and now accepts `signal` and `onWait`.

- [ ] **Step 1: Write failing lease and concurrent-land tests**

```js
test('simultaneous lands serialize and the second rechecks the new HEAD', async () => {
  const [first, second] = await Promise.all([
    landAgentBranch({ projectPath: fixture.seed, branch: firstBranch }, options),
    landAgentBranch({ projectPath: fixture.seed, branch: secondBranch }, options),
  ])
  assert.equal(first.land.mergedInto, 'main')
  assert.equal(second.land.mergedInto, 'main')
  assert.equal(await commitIsAncestor(first.land.mergeHead, second.land.mergeHead), true)
})
```

Add tests for a waiting notice emitted once, cancellation before acquisition, stale-owner recovery, heartbeat ownership, release after callback failure, and no concurrent canonical-checkout mutation.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test host/repository-land-lease.test.mjs host/git.test.mjs host/auto-land.test.mjs`

Expected: failures demonstrate that current lands can enter the canonical checkout concurrently.

- [ ] **Step 3: Implement the cross-process lease**

Use atomic `mkdir` ownership, `owner.json` atomic replacement, renewable heartbeat, conservative stale quarantine, abort-aware polling, ownership assertions, and `finally` cleanup. Never delete a fresh record owned by another token.

- [ ] **Step 4: Put the entire land transaction behind the lease**

Resolve the repository and common directory, acquire the lease, then perform dirty-check, ahead-check, overlap inspection, `merge-tree`, merge, `land:check`, rollback/final capture, and release. Both explicit `GitWorkflowService.land` and automatic landing already call `landAgentBranch`, so they share the same coordinator.

- [ ] **Step 5: Emit automatic-land waiting status**

Map `onWait` to one `repository_land_waiting` notice in `autoLandWorkspace`; explicit HTTP requests simply remain pending and return their normal success/error response.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test host/repository-land-lease.test.mjs host/git.test.mjs host/auto-land.test.mjs host/server-integrations.test.mjs`

Expected: all tests pass with zero failures.

- [ ] **Step 7: Commit**

```bash
git add host/repository-land-lease.mjs host/repository-land-lease.test.mjs host/git.mjs host/git.test.mjs host/auto-land.mjs host/auto-land.test.mjs
git commit -m "feat: serialize repository landing"
```

### Task 4: Conversation overlap banner

**Files:**
- Create: `src/lib/workspaceOverlap.mjs`
- Create: `src/lib/workspaceOverlap.d.mts`
- Create: `host/workspace-overlap-ui.test.mjs`
- Modify: `src/lib/relayHost.ts`
- Modify: `src/App.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Produces: `activeWorkspaceOverlaps(events)` returning current structured overlaps reduced by peer branch.
- Produces: `workspaceOverlapSummary(overlaps, branchTitles)` returning bounded accessible display copy.

- [ ] **Step 1: Write failing reducer and source-contract tests**

```js
test('detected and cleared events rebuild only current overlaps after reconnect', () => {
  const events = [detected('peer-a', ['src/App.tsx']), detected('peer-b', ['host/git.mjs']), cleared('peer-a')]
  assert.deepEqual(activeWorkspaceOverlaps(events).map(item => item.peerBranch), ['peer-b'])
})
```

Also assert multiple-peer aggregation, three-path display bounding, exact remaining count, banner `role="status"`, and that the banner is rendered outside the collapsible execution output.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test host/workspace-overlap-ui.test.mjs`

Expected: failure because the reducer and banner do not exist.

- [ ] **Step 3: Implement the pure reducer and types**

Ignore malformed overlap events, reduce by peer branch and sequence order, remove cleared peers, deduplicate paths, and generate deterministic copy with locally known chat titles when available.

- [ ] **Step 4: Render the accessible amber banner**

Derive overlaps from the current chat's retained execution events, render above the composer even when the CLI panel is collapsed, use `AlertTriangle`, and add responsive light/dark CSS with path wrapping and no focus capture.

- [ ] **Step 5: Run focused tests, typecheck, and verify GREEN**

Run: `node --test host/workspace-overlap-ui.test.mjs && npx tsc --noEmit -p tsconfig.app.json`

Expected: all tests pass and TypeScript exits zero.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workspaceOverlap.mjs src/lib/workspaceOverlap.d.mts host/workspace-overlap-ui.test.mjs src/lib/relayHost.ts src/App.tsx src/index.css
git commit -m "feat: show cross-conversation edit warnings"
```

### Task 5: Full verification, landing, and installed-app refresh

**Files:**
- Modify only if verification identifies a feature regression.

**Interfaces:**
- Consumes all prior tasks.
- Produces a landed `main` build installed through `scripts/install-app.mjs`.

- [ ] **Step 1: Run the complete repository land gate**

Run: `npm run land:check`

Expected: lint, TypeScript, Host tests, and desktop tests all pass with zero failures.

- [ ] **Step 2: Inspect the final diff and repository state**

Run: `git diff --check && git status --short && git log --oneline --decorate -8`

Expected: no whitespace errors, only intentional feature commits, and no unrelated changes.

- [ ] **Step 3: Merge the isolated feature branch into current `main`**

Recheck that canonical `main` is clean and has not moved unexpectedly, merge without choosing one side automatically, rerun `npm run land:check` on the merged tree, and stop if any concurrent change requires reconciliation.

- [ ] **Step 4: Install and verify the packaged app**

Run: `node scripts/install-app.mjs && codesign --verify --strict /Applications/Ensync.app`

Expected: renderer/Host installation completes, signing verifies, and the installer leaves the active daemon to retire safely.

- [ ] **Step 5: Relaunch only the native app UI**

Use the environment-clean launch command documented in shared project memory. Do not kill the detached Ensync Host daemon or active provider jobs. Confirm the native window process is present.

- [ ] **Step 6: Update durable memory**

Update the existing `git-workflows.md` Claude project-memory topic with verified implementation details and failure-prevention guidance; keep transient logs out of memory.

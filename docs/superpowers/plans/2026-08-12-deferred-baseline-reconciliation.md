# Deferred Baseline Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an existing conversation continue from its exact protected branch when newer baseline changes conflict, then reconcile safely through the guarded landing pipeline.

**Architecture:** Project isolation aborts the failed admission merge and returns the clean branch with bounded `baselineConflict` metadata. Chat execution includes that metadata in its workspace notice and provider preamble; normal automatic landing remains responsible for contained conflict resolution, semantic verification, serialization, and rollback.

**Tech Stack:** Node.js ESM, Git worktrees, `node:test`, React/TypeScript host contracts.

## Global Constraints

- The selected project and exact conversation workspace remain strict context boundaries.
- Never replay a capacity/quota failure after verified provider activity.
- Never start a provider with `MERGE_HEAD`, unmerged index entries, or admission-created conflict markers.
- Never mutate the canonical checkout during workspace admission.
- macOS and Windows path behavior must remain equivalent.
- SSH behavior is unchanged.

---

### Task 1: Reacquire a baseline-conflicted conversation

**Files:**
- Modify: `host/project-isolation.mjs`
- Test: `host/project-isolation.test.mjs`

**Interfaces:**
- Produces: `workspace.baselineConflict: { baselineSha: string, files: string[], reason: string } | null`.
- Preserves: a clean protected worktree on its exact existing `ensync/chat-*` branch.

- [ ] **Step 1: Change the existing conflict regression test to require successful reacquisition**

Create conflicting conversation and baseline commits, call `acquire`, and assert the original branch is returned, `tracked.txt` retains the conversation version, `git rev-parse -q --verify MERGE_HEAD` fails, `git diff --name-only --diff-filter=U` is empty, and `baselineConflict.files` is `['tracked.txt']`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern='defers conflicting baseline synchronization' host/project-isolation.test.mjs`

Expected: FAIL because acquisition currently throws `workspace_baseline_conflict`.

- [ ] **Step 3: Implement deferred conflict metadata**

In `#ensureWorkspace`, abort a failed reused-workspace baseline merge, verify the abort succeeded, retain bounded sorted conflict paths, skip the same-acquisition refresh, and include `baselineConflict` in the returned workspace. Continue throwing if Git cannot restore a clean non-merging state.

- [ ] **Step 4: Run focused project-isolation tests**

Run: `node --test host/project-isolation.test.mjs`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add host/project-isolation.mjs host/project-isolation.test.mjs
git commit -m "fix: keep conflicted conversations resumable"
```

### Task 2: Explain deferred reconciliation to the provider and renderer

**Files:**
- Modify: `host/chat.mjs`
- Modify: `host/chat.test.mjs`
- Modify: `src/lib/relayHost.ts`

**Interfaces:**
- Consumes: `workspace.baselineConflict` from Task 1.
- Produces: structured `project_workspace_ready.workspace.baselineConflict` and a provider preamble naming the exact paths and deferred landing behavior.

- [ ] **Step 1: Write a failing ChatRunService test**

Supply a pre-acquired workspace with `baselineConflict`, run a real service boundary with the existing fake process runner, and assert the provider cwd remains that workspace and its prompt names the baseline SHA, exact conflicted path, preserved clean branch, and reconciliation-before-landing rule. Assert the ready notice carries the same structured metadata.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern='deferred baseline conflict' host/chat.test.mjs`

Expected: FAIL because neither prompt nor notice currently includes the metadata.

- [ ] **Step 3: Implement bounded advisory copy and public typing**

Extend the isolation preamble and workspace ready payload without changing normal-workspace copy. Add the optional shape to `ChatExecutionEvent` workspace typing so persisted/replayed notices remain type-safe.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node --test host/chat.test.mjs host/project-isolation.test.mjs host/auto-land.test.mjs && npx tsc --noEmit -p tsconfig.app.json`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add host/chat.mjs host/chat.test.mjs src/lib/relayHost.ts
git commit -m "fix: explain deferred baseline reconciliation"
```

### Task 3: Verify, merge, and refresh the installed app

**Files:**
- Modify only if verification exposes a regression.

**Interfaces:**
- Consumes Tasks 1–2.
- Produces a verified merge on `main` and an installed signed app bundle.

- [ ] **Step 1: Run the complete land gate**

Run: `npm run land:check`

Expected: lint, TypeScript, Host tests, and desktop tests exit zero.

- [ ] **Step 2: Inspect the final branch**

Run: `git diff --check && git status --short && git log --oneline --decorate -8`

Expected: clean feature branch with only intentional commits.

- [ ] **Step 3: Merge into the current clean `main` and rerun `npm run land:check`**

Do not choose one side automatically if `main` moved. Reconcile current changes explicitly, then verify the merged tree.

- [ ] **Step 4: Install, sign, and relaunch only the UI**

Run: `node scripts/install-app.mjs && codesign --verify --strict /Applications/Ensync.app`. Quit/reopen the native UI through macOS LaunchServices without terminating the detached Host daemon or active provider jobs.

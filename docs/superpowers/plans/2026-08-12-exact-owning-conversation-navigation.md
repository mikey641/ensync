# Exact Owning Conversation Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user reopen the exact retained conversation named by a provider instead of repeatedly continuing in the wrong Ensync chat.

**Architecture:** A pure renderer-side resolver extracts a protected branch or workspace-ID reference from the latest agent message and uniquely matches it against live chats in the current window plus checksummed snapshots for other retained workspaces. The existing authenticated native focus IPC gains a separate exact idle-chat target, and the receiving renderer revalidates the workspace, project, path, and chat before selection. The UI presents an explicit action and never transfers or executes text automatically.

**Tech Stack:** React, TypeScript, Electron IPC, Node test runner, checksummed localStorage snapshots.

## Global Constraints

- Preserve the conversation-first interface and subscription-only provider routing.
- Never enter, mutate, merge, or execute inside another conversation's worktree.
- Never transfer or replay a user message as part of navigation.
- Fail closed on ambiguous identities, invalid snapshots, missing retained workspaces, or mismatched project/chat coordinates.
- Keep macOS and Windows path behavior equivalent.

---

### Task 1: Resolve one exact owning conversation

**Files:**
- Modify: `src/lib/nativeWorkspaceRouting.mjs`
- Modify: `src/lib/nativeWorkspaceRouting.d.mts`
- Test: `host/native-workspace-routing.test.mjs`

**Interfaces:**
- Produces: `findReferencedOwningConversation(storage, options)` returning exact workspace/project/chat coordinates and display labels from either the current live window or another retained snapshot, or `null`.
- Produces: `exactNativeChatFocusCanApply(request, current)` for target-renderer validation.

- [ ] **Step 1: Write failing tests** for a shortened unique branch reference, ambiguous prefixes, corrupt snapshots, current-chat exclusion, and Windows path validation.
- [ ] **Step 2: Run** `node --test host/native-workspace-routing.test.mjs` and verify the new imports or assertions fail.
- [ ] **Step 3: Implement the bounded resolver** using retained identities and `readWorkspaceSnapshot`, requiring the latest message to be an agent response and a unique branch prefix of 6–24 hexadecimal characters.
- [ ] **Step 4: Run** `node --test host/native-workspace-routing.test.mjs` and verify all tests pass.
- [ ] **Step 5: Commit** the resolver and tests.

### Task 2: Authorize exact idle-chat native focus

**Files:**
- Modify: `desktop/src/native-workspaces.mjs`
- Modify: `src/vite-env.d.ts`
- Test: `desktop/test/native-workspaces.test.mjs`
- Test: `desktop/test/native-ipc-order.test.mjs`

**Interfaces:**
- Consumes: `{ workspaceId, projectId, projectPath, chatId }` from Task 1.
- Produces: `NativeExactChatTarget`, distinct from project-only and exact active-run requests.

- [ ] **Step 1: Write failing tests** proving an authorized retained idle chat can focus without a job ID while malformed partial bindings and active-run requests without a live roster still fail.
- [ ] **Step 2: Run** `node --test desktop/test/native-workspaces.test.mjs desktop/test/native-ipc-order.test.mjs` and verify failure.
- [ ] **Step 3: Add exact-chat normalization and routing** while preserving the existing live-roster requirement for targets that include `jobId`.
- [ ] **Step 4: Update renderer bridge unions** and run the focused tests to green.
- [ ] **Step 5: Commit** native authorization and types.

### Task 3: Present and apply the navigation action

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Modify: `.relay/features/workspace-tabs.md`

**Interfaces:**
- Consumes: Task 1's exact target and Task 2's `focusWorkspace` request.
- Produces: the visible **Open owning conversation** banner and exact target activation.

- [ ] **Step 1: Derive one target per pane** from the latest agent response and current retained-workspace roster.
- [ ] **Step 2: Add the explicit banner action** with pending/error states; keep the current pane unchanged on failure.
- [ ] **Step 3: Extend `onWorkspaceProjectFocus`** so an exact chat without a job ID is activated only after `exactNativeChatFocusCanApply` succeeds.
- [ ] **Step 4: Add compact responsive styling** and document the durable feature rule in `workspace-tabs.md`.
- [ ] **Step 5: Run** `npm run lint`, `tsc --noEmit -p tsconfig.app.json`, and the focused host/desktop tests.
- [ ] **Step 6: Commit** the renderer and documentation change.

### Task 4: Verify, land, install, and exercise the fix

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: the completed exact-navigation feature.
- Produces: merged `main`, a locally installed Ensync app, and runtime evidence that the Task 7 conversation opens without provider execution.

- [ ] **Step 1: Run** `npm run land:check` and require a zero exit code.
- [ ] **Step 2: Merge** the feature branch into `main` without discarding unrelated user work.
- [ ] **Step 3: Run** `node scripts/install-app.mjs` from merged `main` and relaunch Ensync normally.
- [ ] **Step 4: Exercise the action** against the retained `ensync/chat-aff577…` reference and confirm the Nadlan Task 7 chat becomes active while no Host job starts.
- [ ] **Step 5: Record durable behavior** in shared project memory and report the exact verification results.

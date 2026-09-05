# Failed-Run Terminal Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a failed provider turn publishes its terminal failure immediately after protected-worktree work is saved and ownership is released.

**Architecture:** Keep the current immediate-landing architecture and safe pre-mutation fallback boundary. Shared-checkout observation remains best-effort for successful turns, but failed, cancelled, and timed-out turns do not await it because it is neither required to preserve their work nor allowed to delay their terminal outcome.

**Tech Stack:** Node.js ES modules, `node:test`, Ensync Host `ChatRunService`.

## Global Constraints

- Preserve automatic Claude-to-Codex fallback only for Host-verified zero-activity failures.
- Preserve the protected conversation worktree and commit failed-run changes before terminal publication.
- Preserve equal macOS and Windows behavior; add no platform-specific path or process logic.
- Ensync Host owns commits and landing for this protected branch; do not push or manually integrate it.

---

### Task 1: Remove best-effort observation from failed-run finalization

**Files:**
- Modify: `host/chat.test.mjs`
- Modify: `host/chat.mjs`
- Modify: `.ensync/features/agent-routing.md`

**Interfaces:**
- Consumes: `ChatRunService.run(request, options)` and `ProjectIsolationService.checkSharedCheckout(workspace)`.
- Produces: failed-run finalization that still invokes `commitAgentWork`, never invokes `checkSharedCheckout`, releases ownership, and returns the original non-retryable provider error.

- [x] **Step 1: Write the failing regression test**

Add a `ChatRunService` test whose provider exits unsuccessfully after starting, whose work snapshot reports one committed file, and whose shared-checkout observer records calls. Assert the run returns the original `cli_failed` error, emits `agent_work_committed`, releases the lease, and never calls the observer.

- [x] **Step 2: Run the regression test to verify it fails**

Run: `node --test --test-name-pattern="failed provider run publishes" host/chat.test.mjs`

Expected: FAIL because the current `finally` path calls `checkSharedCheckout` for every run outcome.

- [x] **Step 3: Implement the minimal outcome guard**

Guard the best-effort `checkSharedCheckout` block with `runOutcome === 'succeeded'`. Do not change work snapshotting, ownership release, landing enqueue, or fallback classification.

- [x] **Step 4: Document the durable finalization rule**

Update `.ensync/features/agent-routing.md` to state that failed/cancelled/timed-out local runs save work and release ownership without awaiting shared-checkout observation, while zero-activity failures remain the only automatic replay boundary.

- [x] **Step 5: Run focused verification**

Run: `node --test --test-name-pattern="failed provider run publishes|Claude startup-only|Claude code 1 after|quota retry safety|safe quota failure" host/chat.test.mjs`

Expected: all selected tests pass.

- [x] **Step 6: Run full verification**

Run: `npm run lint && npm run test:host && npm run build && npm --prefix desktop test`

Expected: all commands exit 0.

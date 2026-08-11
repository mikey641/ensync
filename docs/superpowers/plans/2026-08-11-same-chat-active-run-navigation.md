# Same-chat Active-run Navigation and Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace retained waiter jobs with Host-authoritative `occupied` admission, let a waiting window open the exact active conversation, and safely transfer its FIFO head to that owner for verified local-Codex Push now.

**Architecture:** Ensync Host acquires or describes the conversation worktree lease before journaling or starting a retained job and returns a three-way admission result. Electron owns an authenticated live-window roster plus exact focus and idempotent message-handoff IPC; the renderer persists occupied-owner and transfer state, revalidates all bindings, and reuses the existing exact-job steering path. The filesystem lease remains cross-process authority, the Host remains execution authority, and the shell remains navigation authority.

**Tech Stack:** Node.js ESM Host services and `node:test`, Electron main/preload IPC, React 19 + TypeScript, Vite, existing checksummed workspace persistence helpers.

## Global Constraints

- A second message for an already-running conversation stays visibly queued and creates no second retained Host job or provider process.
- **View active run** appears only for the exact Host owner plus shell-authenticated workspace/project/chat/job roster binding.
- **Push now** remains limited to the exact still-active, Host-verified local Codex turn; Claude, SSH, older/non-steerable Codex, and every other provider retain two-step **Stop & send now** when controllable.
- Proven steering rejection keeps the message queued; ambiguous steering marks it interrupted and removes it from automatic execution.
- Persist the target copy before acknowledging a cross-window handoff; only after acknowledgement may the source become `transferred`.
- A `transferred` message stays visible for audit but is excluded from FIFO drain, provider transcript/session cursors, unread completion, retry, and execution.
- Do not expose prompts, provider output, attachment paths, repository paths, lease tokens, raw requests, or a global active-job listing in occupied metadata.
- Preserve conversation-first UI, subscription-only routing, safe pre-mutation fallback, and equal macOS/Windows behavior.
- Browser and cross-Host cases report factual limitations and never simulate native focus, steering, cancellation, or ownership.
- Work only in the Ensync-protected current worktree; do not create, switch, merge, delete, or clean branches/worktrees.

---

### Task 1: Non-blocking Host workspace admission

**Files:**
- Modify: `host/project-isolation.mjs`
- Modify: `host/project-isolation.test.mjs`

**Interfaces:**
- Consumes: existing `ProjectIsolationService.acquire(projectPath, workspaceKey, options)` lease creation and stale-lock quarantine.
- Produces: `ProjectIsolationService.tryAcquireOrDescribe(projectPath, workspaceKey, { signal, owner }) -> Promise<{ disposition: 'acquired'; lease } | { disposition: 'occupied'; owner }>`.
- Produces: an acquired lease with `workspace`, `signal`, `assertHeld()`, `updateOwner(patch)`, and idempotent `release()`.
- Produces: bounded owner shape `{ jobId, provider, targetKind, startedAt, providerProcessStarted, steerable, nativeWorkspaceId }`, where every invalid or unknown field is `null`/`false` rather than copied through.

- [ ] **Step 1: Write failing local and cross-service admission tests**

Add tests which acquire one conversation with owner `job_1111111111111111`, call `tryAcquireOrDescribe` through a second service rooted elsewhere, and assert literal `occupied` metadata. Assert the second call returns within 500 ms, emits no waiting callback, and that another workspace key still returns `acquired`.

```js
const first = await serviceA.tryAcquireOrDescribe(projectPath, 'workspace:chat-a', {
  owner: {
    jobId: 'job_1111111111111111', provider: 'codex', targetKind: 'local',
    startedAt: '2026-08-11T10:00:00.000Z', providerProcessStarted: false,
    steerable: false, nativeWorkspaceId: '11111111-1111-4111-8111-111111111111',
  },
})
const second = await serviceB.tryAcquireOrDescribe(projectPath, 'workspace:chat-a', {
  owner: { jobId: 'job_2222222222222222', provider: 'claude', targetKind: 'local' },
})
assert.equal(first.disposition, 'acquired')
assert.deepEqual(second, {
  disposition: 'occupied',
  owner: {
    jobId: 'job_1111111111111111', provider: 'codex', targetKind: 'local',
    startedAt: '2026-08-11T10:00:00.000Z', providerProcessStarted: false,
    steerable: false, nativeWorkspaceId: '11111111-1111-4111-8111-111111111111',
  },
})
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --test --test-name-pattern='non-blocking admission|bounded occupied owner|different workspace admission' host/project-isolation.test.mjs`

Expected: FAIL because `tryAcquireOrDescribe` and owner metadata do not exist.

- [ ] **Step 3: Implement one-attempt acquire-or-describe**

Refactor the private lease acquisition so the existing blocking `acquire` retains its loop, while `tryAcquireOrDescribe` performs exactly one acquisition attempt after stale-lock quarantine. Write only normalized bounded fields to `owner.json`; heartbeat writes preserve updated owner metadata. Never return token, PID, path, or raw JSON.

```js
async tryAcquireOrDescribe(projectPath, rawWorkspaceKey, options = {}) {
  const prepared = await this.#prepareRepository(projectPath, rawWorkspaceKey, options.signal)
  const result = await this.#tryAcquireWorkspaceLease(
    prepared.repository.commonGitDirectory,
    prepared.key,
    options,
  )
  if (result.disposition === 'occupied') return result
  try {
    const workspace = await this.#prepareWorkspace(prepared, options)
    return { disposition: 'acquired', lease: { ...result.lease, workspace } }
  } catch (error) {
    await result.lease.release()
    throw error
  }
}
```

- [ ] **Step 4: Verify heartbeat updates and stale-lock behavior**

Add a test that calls `first.lease.updateOwner({ providerProcessStarted: true, steerable: true })`, waits for the atomic record write, and verifies a later description returns those two booleans without any disallowed key. Re-run the pre-existing cancellation, heartbeat, stale quarantine, same-chat serialization, and different-chat concurrency tests.

Run: `node --test --test-name-pattern='non-blocking admission|bounded occupied owner|different workspace admission|heartbeat|stale|serialize duplicate runs|different conversation' host/project-isolation.test.mjs`

Expected: PASS.

---

### Task 2: Host retained-job admission dispositions

**Files:**
- Modify: `host/chat-jobs.mjs`
- Modify: `host/chat-jobs.test.mjs`
- Modify: `host/chat.mjs`
- Modify: `host/chat.test.mjs`
- Modify: `host/server.mjs`
- Modify: `host/server-integrations.test.mjs`
- Modify: `src/lib/relayHost.ts`

**Interfaces:**
- Consumes: Task 1 `tryAcquireOrDescribe` and its acquired lease.
- Produces: async `ChatJobService.start(input) -> Promise<ChatJobAdmission>`.
- Produces: `ChatJobAdmission = { disposition: 'started' | 'reconnected'; job: ChatJobSnapshot } | { disposition: 'occupied'; owner: OccupiedChatJobOwner }`.
- Produces: top-level start input `navigation?: { nativeWorkspaceId: string | null; projectId: string; chatId: string; turnId: string }`; it is admission-only and never reaches provider requests or the journal. `turnId` is retained only in the owning Host process and is `null` in cross-Host occupied descriptions.
- Produces: `ChatRunService.run(request, { preAcquiredWorkspaceLease, ... })`, where the retained job owns release after the complete landing lifecycle.
- Produces: `ChatJobOccupiedError` in `src/lib/relayHost.ts`, carrying only `owner` and thrown by `runChatJob` before stream attachment.
- Produces: `steer(jobId, { idempotencyKey, prompt, attachments })`, where one job/key/content tuple owns one retained delivery outcome; identical repeats never call the provider twice and same-key/different-content returns HTTP 409.

- [ ] **Step 1: Write failing `started` / `reconnected` / `occupied` service tests**

Use a deferred local runner and injected `admit` callback. Assert exact job ID plus request hash returns `reconnected`; a different job ID for the same coordinate returns `occupied`; the second runner is never called; no second job can be fetched; and only the started job is saved to the journal.

```js
assert.equal((await jobs.start(firstInput)).disposition, 'started')
assert.equal((await jobs.start(firstInput)).disposition, 'reconnected')
const occupied = await jobs.start(secondInput)
assert.equal(occupied.disposition, 'occupied')
assert.equal(localRuns.length, 1)
assert.throws(() => jobs.get(secondInput.jobId), { code: 'chat_job_not_found' })
```

- [ ] **Step 2: Run the focused ChatJob tests and confirm RED**

Run: `node --test --test-name-pattern='admission disposition|occupied job|pre-acquired lease|request hash' host/chat-jobs.test.mjs`

Expected: FAIL because `start` is synchronous and always creates a job.

- [ ] **Step 3: Implement async admission and release ownership**

Inject `admit(input, owner)` into `ChatJobService`. Validate idempotency before calling it. On `occupied`, return immediately. On acquired admission, store the lease only in the live in-memory job, durably persist the redacted job, start execution, call `updateOwner` on provider-start and live-steer readiness/closure events, and release in `#execute` `finally`. Registration failure must delete the in-memory job and release the lease before rethrowing.

```js
const admission = await this.#admit(input, publicOwnerFromStartInput(input, this.#now()))
if (admission.disposition === 'occupied') return admission
const job = createRunningJob(input, hash, admission.lease)
try { this.#persist() } catch (error) {
  this.#jobs.delete(id)
  await admission.lease?.release()
  throw journalRegistrationError(error)
}
queueMicrotask(() => { job.completion = this.#execute(job) })
return { disposition: 'started', job: this.#publicJob(job) }
```

- [ ] **Step 4: Pass a pre-acquired lease through ChatRunService**

Write a failing `host/chat.test.mjs` case that supplies a pre-acquired lease and asserts `projectIsolation.acquire` is not called, provider execution uses `lease.workspace`, and ChatRunService does not release the externally owned lease. Keep direct `/api/chat/run` responsible for its own acquire/release.

Run: `node --test --test-name-pattern='pre-acquired workspace lease' host/chat.test.mjs`

Expected before implementation: FAIL; expected after the minimal option branch: PASS.

- [ ] **Step 5: Wire the async route and bounded response**

Make `POST /api/chat/jobs` await `chatJobs.start`. Configure local admission with `projectIsolation.tryAcquireOrDescribe`; leave current SSH execution Host-local and return no native controls for any cross-Host lock wait. Return HTTP 202 for `started`, HTTP 200 for `reconnected` or `occupied`.

```js
const admission = await chatJobs.start(body)
return sendJson(response, admission.disposition === 'started' ? 202 : 200, admission, origin)
```

Add an integration test whose occupied JSON is recursively inspected for forbidden keys and values (`prompt`, `attachments`, `projectPath`, `repositoryPath`, `token`, `pid`, `request`).

- [ ] **Step 6: Update the browser Host client**

Define literal TypeScript unions for `ChatJobAdmission` and `OccupiedChatJobOwner`. `startChatJob` returns that union. `runChatJob` attaches only for `started`/`reconnected`; on `occupied` it throws `new ChatJobOccupiedError(owner)` so App integration can convert the pending message to FIFO without treating it as a provider failure.

Add a failing steer test before implementation: two concurrent identical `idempotencyKey` calls join one provider delivery, a later identical call returns the retained outcome, and the same key with different prompt or attachments throws `live_steer_conflict` with status 409. Retain a safe rejection or ambiguous error as that key's outcome so retrying the HTTP request can never resend an instruction whose delivery state was already decided or became unknown.

- [ ] **Step 7: Run Host admission verification**

Run: `node --test host/project-isolation.test.mjs host/chat-jobs.test.mjs host/chat.test.mjs host/server-integrations.test.mjs host/chat-job-reconnect.test.mjs host/host-job-recovery.test.mjs`

Expected: PASS with no second runner/journal entry in the occupied cases.

---

### Task 3: Authorized native active-run roster and handoff IPC

**Files:**
- Modify: `desktop/src/native-workspaces.mjs`
- Modify: `desktop/test/native-workspaces.test.mjs`
- Modify: `desktop/src/main.mjs`
- Modify: `desktop/src/preload.cjs`
- Modify: `src/vite-env.d.ts`
- Modify: `desktop/test/native-ipc-order.test.mjs`

**Interfaces:**
- Produces: `createActiveRunRoster({ isAuthorized, identityForWebContents })` with `publish(event, entries)`, `matches(target)`, `removeWorkspace(workspaceId)`, and bounded `listForWorkspace(workspaceId)`.
- Produces native bridge methods `publishActiveRuns(entries)`, `focusWorkspace(exactRequest)`, `handoffQueuedMessage(request)`, and `onQueuedMessageHandoff(callback)`.
- Exact target: `{ workspaceId, projectId, projectPath, chatId, jobId }`.
- Handoff payload: `{ handoffId, target, entry }`, where `entry` is the stable `QueuedPrompt` snapshot and no arbitrary extra fields survive normalization.
- Handoff result: `{ status: 'accepted' | 'rejected' | 'unavailable'; handoffId; messageId }`.

- [ ] **Step 1: Write failing roster authorization and lifecycle tests**

Test two registered workspace identities and webContents. Assert unauthorized publication fails, the authorized source cannot claim another workspace, replacement removes old jobs atomically, entries are bounded to 32, exact matching requires all workspace/project/path/chat/job fields, and `removeWorkspace` makes later focus/handoff unavailable.

- [ ] **Step 2: Run roster tests and confirm RED**

Run: `node --test --test-name-pattern='active run roster|exact active run focus|queued message handoff' desktop/test/native-workspaces.test.mjs`

Expected: FAIL because the roster and channels do not exist.

- [ ] **Step 3: Implement normalized roster and exact focus**

Extend `createWorkspaceFocusHandler` so legacy project-only focus still follows its current checks, while a request containing either `chatId` or `jobId` must contain both and match the authenticated roster before `focusWindow`. The notification to the target includes the exact chat/job pair only after this check.

```js
const exact = normalizeExactRunTarget(request)
if ((request.chatId !== undefined || request.jobId !== undefined)
  && (!exact || !activeRuns.matches(exact))) return false
await notifyProjectFocus(targetWindow, exact ?? project)
```

- [ ] **Step 4: Implement idempotent persist-before-ack handoff routing**

The main process validates the source event and exact target roster, hashes the stable handoff payload, and sends it only to the target webContents. Duplicate `handoffId` plus identical hash returns the retained result; the same ID with different content returns `rejected`. Resolve only after the target invokes the ACK channel; a 5-second timeout returns `unavailable` without marking source state.

- [ ] **Step 5: Wire main lifecycle and preload surface**

Register/remove the new handlers beside existing workspace handlers. Remove roster entries and reject pending handoffs when a window closes. In preload, keep channel names fixed and pass only callback results back through ACK; do not expose `ipcRenderer` or generic send/invoke.

- [ ] **Step 6: Verify native IPC on both platform-neutral code paths**

Run: `node --test desktop/test/native-workspaces.test.mjs desktop/test/native-ipc-order.test.mjs desktop/test/native-windows.test.mjs`

Expected: PASS; tests use path fixtures for POSIX and Windows drive/UNC forms.

---

### Task 4: Persistent transfer and occupied-owner state helpers

**Files:**
- Modify: `src/types.ts`
- Modify: `src/lib/promptQueue.mjs`
- Modify: `src/lib/promptQueue.d.mts`
- Modify: `src/lib/accountWorkspaceSync.mjs`
- Modify: `src/lib/autoContextPrompt.mjs`
- Modify: `src/lib/autoContextPrompt.d.mts`
- Modify: `src/lib/chatAutoScroll.mjs`
- Modify: `host/prompt-queue.test.mjs`
- Modify: `host/account-workspace-sync.test.mjs`
- Modify: `host/workspace-persistence.test.mjs`

**Interfaces:**
- Adds message delivery state `'transferred'`.
- Produces `markQueuedMessageTransferred(messages, messageId) -> Message[]`.
- Produces `acceptTransferredPrompt(queues, chats, chatId, entry) -> { status: 'accepted' | 'duplicate' | 'conflict'; queues; chats }`.
- Produces `occupiedRunCanNavigate(owner, currentBinding)` and `occupiedRunCanHandoff(owner, entry, currentBinding)` pure fail-closed predicates.
- Consumes unchanged queue promotion/rejection/ambiguity behavior after the target owns the prompt.

- [ ] **Step 1: Write failing transferred-state tests**

Assert a transferred source message remains in `Chat.messages`, is absent from `PromptQueues`, cannot satisfy `queuedPromptGate`, is omitted from provider transcript labels and session cursor counts, and does not create unread completion. Assert the target accepts one identical handoff, treats a repeat as duplicate, and treats same ID/different prompt or attachment as conflict.

- [ ] **Step 2: Run the focused pure-state tests and confirm RED**

Run: `node --test --test-name-pattern='transferred|handoff|occupied owner' host/prompt-queue.test.mjs host/account-workspace-sync.test.mjs host/workspace-persistence.test.mjs`

Expected: FAIL because `transferred` and handoff helpers do not exist.

- [ ] **Step 3: Implement minimal pure transforms and types**

Normalize handoff entries through the same queue validator, compare a canonical JSON identity containing IDs, predecessor, prompt, attachments, and routing snapshot, and never mutate input arrays. `markQueuedMessageTransferred` changes only the exact queued user message.

```js
export function markQueuedMessageTransferred(messages, messageId) {
  return messages.map((message) => message.id === messageId
    && message.role === 'user'
    && message.deliveryStatus === 'queued'
    ? { ...message, deliveryStatus: 'transferred' }
    : message)
}
```

- [ ] **Step 4: Make account merge precedence explicit**

Give `transferred` lower priority than target `queued`, `pending`, and terminal states but higher priority than an unknown copy. Remote portable preparation maps a lone transferred message to interrupted, because account sync cannot execute a cross-device handoff. Local merge keeps the target owner's stronger state for the stable message ID.

- [ ] **Step 5: Run queue, persistence, recovery, and sync tests**

Run: `node --test host/prompt-queue.test.mjs host/workspace-persistence.test.mjs host/workspace-recovery.test.mjs host/account-workspace-sync.test.mjs host/chat-auto-scroll.test.mjs host/auto-context-fallback.test.mjs`

Expected: PASS.

---

### Task 5: Renderer occupied flow, View active run, and cross-window Push now

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/theme.css`
- Modify: `host/prompt-queue.test.mjs`
- Modify: `host/native-workspace-routing.test.mjs`
- Modify: `host/workspace-persistence.test.mjs`

**Interfaces:**
- Consumes: Task 2 `ChatJobOccupiedError.owner`.
- Consumes: Task 3 native bridge roster/focus/handoff methods.
- Consumes: Task 4 transfer/accept/predicate helpers.
- Adds persisted `occupiedRuns?: Record<string, OccupiedChatRun>` to `StoredState`, with `{ ownerJobId, turnId, provider, targetKind, startedAt, providerProcessStarted, steerable, nativeWorkspaceId, projectId, projectPath, chatId, controllable }`. Hydration resets `controllable`; exact shell reachability is separate ephemeral state and is never persisted.

- [ ] **Step 1: Add failing renderer-contract tests**

Add source-level integration assertions only where the repository already uses that style, and put behavior in imported pure helpers wherever possible. Cover: occupied response converts the already-visible pending message to one FIFO entry; no second `inFlightRuns` record remains; exact native owner exposes View; exact steerable local Codex exposes Push; Claude/non-steerable owner exposes only two-step Stop & send when `controllable`; browser and cross-Host owners expose explanatory copy and no action.

- [ ] **Step 2: Run renderer-focused tests and confirm RED**

Run: `node --test host/prompt-queue.test.mjs host/native-workspace-routing.test.mjs host/workspace-persistence.test.mjs`

Expected: FAIL because App has no occupied-owner conversion or native handoff handlers.

- [ ] **Step 3: Publish and consume exact native run bindings**

Add an effect that publishes every local retained `inFlightRuns` entry with job ID, project, and chat, replacing the window roster atomically; publish `[]` during cleanup. Extend the existing focus event handler: when chat/job are present, verify the current project/chat/job, open or unhide the exact chat tab, activate it, and make no change on a stale target.

- [ ] **Step 4: Convert Host occupied admission into FIFO**

Catch only `ChatJobOccupiedError`. Build the queue entry from the already-snapshotted turn/message/preferences, set the user message from `pending` to `queued`, remove the source `inFlightRuns` entry, retain bounded owner state, synchronously commit chats/queue/occupied owner, and finish only the source renderer registry/controller. Do not enter provider-failure, fallback, cancellation, or reconciliation branches.

- [ ] **Step 5: Monitor same-Host owners without replay**

While an occupied owner is `controllable`, poll only `GET /api/chat/jobs/:ownerJobId` with bounded backoff. A running response refreshes truthful `providerProcessStarted`/`steerable`; a terminal response clears occupied state and calls ordinary FIFO drain. A 404/Host loss clears controls but keeps the prompt queued. Never start, cancel, or steer from the poll.

- [ ] **Step 6: Implement View active run**

Call `focusWorkspace({ workspaceId, projectId, projectPath, chatId, jobId })`; show a factual error if it returns false. Render the text-labeled action only when the exact predicate passes.

- [ ] **Step 7: Implement target-first cross-window handoff**

Register `onQueuedMessageHandoff`. The target validates exact local active run and bindings, calls `acceptTransferredPrompt`, updates refs/state, synchronously commits target chats and queue, then returns `accepted`/`duplicate`/`rejected`. On the source, call `handoffQueuedMessage` for FIFO head; only `accepted`/`duplicate` removes the source queue entry and marks its message `transferred`, then focus the owner.

- [ ] **Step 8: Reuse the existing Push now state machine at the target**

After accepted persistence, invoke `handlePushQueuedNow(targetChatId)`. Confirmed delivery promotes one FIFO head; safe rejection remains queued; ambiguous delivery becomes interrupted. The stable message/entry ID is sent as `idempotencyKey` to the Host steer endpoint, and Host rejects same key/different content.

- [ ] **Step 9: Render the compact occupied active-run card**

Show owner provider and elapsed time plus only the authorized actions. Add `View active run` before Push/Stop controls. Display `transferred` beside the source user message. Keep mixed-version `workspace_write_lock_waiting` behavior unchanged and tell native mixed versions to quit/reopen rather than showing unsupported controls.

- [ ] **Step 10: Verify renderer behavior and TypeScript**

Run: `node --test host/prompt-queue.test.mjs host/native-workspace-routing.test.mjs host/workspace-persistence.test.mjs host/account-workspace-sync.test.mjs host/chat-job-reconnect.test.mjs`

Run: `npx tsc --noEmit -p tsconfig.app.json`

Expected: PASS.

---

### Task 6: Documentation reconciliation and whole-task verification

**Files:**
- Modify only if implementation differs factually: `.relay/features/workspace-tabs.md`
- Modify only if an execution boundary changed: `.relay/architecture.md`
- Do not modify: `.relay/features/agent-routing.md` or `.relay/provider-api-research.md` unless provider capability facts changed.

**Interfaces:**
- Consumes: all completed tasks and the approved design.
- Produces: current durable documentation matching verified runtime behavior.

- [ ] **Step 1: Reconcile the approved spec line by line**

Check canonical admission, bounded metadata, journal ordering, renderer FIFO conversion, exact focus, target-first handoff, transferred semantics, steering outcomes, legacy races, browser limits, cross-Host limits, and macOS/Windows equality against code and tests. Fix any missing behavior with a new failing test before production code.

- [ ] **Step 2: Run focused race and regression suites**

Run: `node --test host/project-isolation.test.mjs host/chat-jobs.test.mjs host/chat.test.mjs host/server-integrations.test.mjs host/prompt-queue.test.mjs host/workspace-persistence.test.mjs host/account-workspace-sync.test.mjs host/native-workspace-routing.test.mjs desktop/test/native-workspaces.test.mjs desktop/test/native-ipc-order.test.mjs desktop/test/native-windows.test.mjs`

Expected: PASS.

- [ ] **Step 3: Run the whole landing gate**

Run: `npm run land:check`

Expected: exit 0 with ESLint, TypeScript, all Host tests, and all desktop tests passing.

- [ ] **Step 4: Review the integrated diff**

Generate a diff from the implementation base and request a whole-branch review against `docs/superpowers/specs/2026-08-11-same-chat-active-run-navigation-design.md`. Fix Critical and Important findings through a failing regression test, re-run focused verification, then re-run `npm run land:check`.

- [ ] **Step 5: Commit the verified implementation**

```bash
git add host desktop/src desktop/test src docs/superpowers/plans .relay
git commit -m "Implement same-chat active run handoff"
```

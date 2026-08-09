# Codex Live-Turn Thread Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep retained Codex live steering and visible results bound to the root app-server thread when child or sub-agent notifications share the connection.

**Architecture:** Filter foreign-thread notifications inside `CodexLiveSession.#handleLine` after JSON-RPC response and server-request handling but before root notification state processing. Keep the root turn ID immutable once established, while preserving existing safe queue and non-replayable steering semantics.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict`, Codex app-server JSON-RPC over JSONL.

## Global Constraints

- Work only in the protected Ensync worktree and preserve every unrelated working-tree change.
- Do not add dependencies or alter provider routing, authentication, execution target, queue ownership, or deployment state.
- Keep the root `threadId` and first verified root `turnId` authoritative for the retained session.
- Ignore child-thread progress, command output, token usage, agent messages, and completion notifications on the shared app-server connection.
- Never retry or requeue an ambiguous `turn/steer` delivery.
- Use platform-neutral Node.js behavior for equal macOS and Windows support.

### Task 1: Add the cross-thread regression

**Files:**

- Modify: `host/codex-live-turn.test.mjs:20-160`

- [ ] Extend `fakeCodexAppServer` with an option for injecting child-thread notifications during steering, and expose its `send` helper to the test.

```js
function fakeCodexAppServer(options = {}) {
  // Existing protocol fake.
  if (options.emitChildNotificationsDuringSteer) {
    send({ method: 'item/completed', params: { threadId: CHILD_THREAD_ID, /* child final */ } })
    send({ method: 'thread/tokenUsage/updated', params: { threadId: CHILD_THREAD_ID, /* child usage */ } })
  }
  return { child, requests, send }
}
```

- [ ] Add a test that starts the root turn, injects a child `turn/started`, child commentary, child command output, and child usage before steering, then injects a child final answer and usage during steering.

```js
assert.equal(steerRequest.params.expectedTurnId, ROOT_TURN_ID)
assert.equal(delivery.turnId, ROOT_TURN_ID)
assert.equal(result.response, 'Applied the correction.')
assert.deepEqual(result.usage, ROOT_USAGE)
assert.equal(events.some((event) => JSON.stringify(event).includes('Child-only')), false)
```

- [ ] Run `node --test host/codex-live-turn.test.mjs` and confirm the new test fails against the current implementation because the child turn replaces the root expected turn and/or child data contaminates the result.

### Task 2: Isolate root-thread notification state

**Files:**

- Modify: `host/codex-live-turn.mjs:409-455`
- Test: `host/codex-live-turn.test.mjs`

- [ ] After the JSON-RPC response and server-request branches, ignore any notification with an explicit `params.threadId` that differs from the retained root thread.

```js
const params = message.params
if (
  this.#threadId
  && typeof params?.threadId === 'string'
  && params.threadId !== this.#threadId
) return
```

- [ ] Make `turn/started` mark activity without replacing an already-established root turn ID.

```js
if (message.method === 'turn/started' && params?.turn?.id) {
  if (!this.#turnId) this.#turnId = params.turn.id
  this.#turnStarted = true
}
```

- [ ] Run `node --test host/codex-live-turn.test.mjs` and confirm every focused test passes.

### Task 3: Verify integration and release readiness

**Files:**

- Verify: `host/codex-live-turn.mjs`
- Verify: `host/codex-live-turn.test.mjs`
- Verify: `package.json`
- Verify: `desktop/package.json`

- [ ] Run the full Host suite with `npm run test:host`.
- [ ] Run the renderer build with `npm run build`.
- [ ] Run `git diff --check` and inspect only the new hunks in the two implementation files.
- [ ] Run the repository's `npm run release:verify` only if the focused suite and build are green and its prerequisites are locally available.
- [ ] Inspect `.relay/features/distribution.md` and the desktop release scripts before any packaging or external release action. Do not claim or perform signing, notarization, publication, or remote deployment unless a concrete authorized target and credentials are verified.

### Task 4: Record the durable behavior

**Files:**

- Modify: `.relay/features/agent-routing.md`

- [ ] Update the existing isolation decision only if implementation reveals a new durable invariant not already captured by commit `1aeb086`.
- [ ] Self-review the final diff for accidental overlap with the pre-existing 116-file working tree.
- [ ] If committing, stage only the new implementation hunks (for example with a reviewed patch or `git add -p`), inspect `git diff --cached`, and do not stage unrelated edits in modified files.

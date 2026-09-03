# Automatic Remote Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic FIFO landing publish its exact verified target commit to the configured Git remote before the landing journal reports success.

**Architecture:** A focused landing-remote helper captures one immutable remote target ref, validates all network-capable Git locations, pushes an exact SHA without force, and verifies the remote result. `LandingIntegrator` reconciles that captured remote commit in its isolated worktree and reports success only after remote confirmation; `LandingCoordinator` gives remote-only failures bounded background retries while existing content-conflict retries remain event-driven.

**Tech Stack:** Node.js ESM, built-in `node:test`, Git CLI with argument arrays, pinned `agent-worktree@0.13.6`, checksummed landing journal.

## Global Constraints

- Use `origin` when configured, otherwise the first configured remote.
- Use existing Git credential helpers or SSH agents only; never collect or persist tokens.
- Validate fetch and push URLs before each corresponding network operation.
- Never force-push, run repository hooks/scripts, push chat branches, or create a manual merge-review state.
- Preserve completion-order FIFO per repository and concurrency across repositories.
- A configured remote requires remote confirmation before `landed`; no remote retains local-only landing.
- Preserve equal macOS and Windows behavior and test only against temporary local bare remotes.

---

### Task 1: Safe landing remote helper

**Files:**
- Create: `host/landing-remote.mjs`
- Create: `host/landing-remote.test.mjs`
- Modify: `host/git.mjs`

**Interfaces:**
- Consumes: `runGit(args, options)`, `getGitStatus(projectPath, options)`, and the existing configured-remote URL validation.
- Produces: `LandingRemotePublisher.capture(input, runtime)`, `LandingRemotePublisher.publish(input, runtime)`, and `LandingRemotePublisher.release(snapshot, runtime)`.
- `capture({ repositoryPath, targetBranch })` returns `{ kind: 'local_only' }` or `{ kind: 'remote', remote, targetBranch, branch, ref, sha }`, where `sha` is `null` only when the remote target does not exist.
- `publish({ snapshot, publishedSha })` returns `{ remoteSha }` only after `ls-remote` confirms the exact SHA.

- [ ] **Step 1: Write failing helper tests**

Add temporary-repository tests that establish a local bare `origin`, then assert:

```js
const publisher = new LandingRemotePublisher({ idFactory: () => 'remote-test' })
const snapshot = await publisher.capture({ repositoryPath, targetBranch: 'main' })
assert.equal(snapshot.kind, 'remote')
assert.equal(snapshot.remote, 'origin')
assert.equal(snapshot.sha, remoteBaseline)
assert.equal(await git(repositoryPath, ['rev-parse', snapshot.ref]), remoteBaseline)

const result = await publisher.publish({ snapshot, publishedSha: localHead })
assert.equal(result.remoteSha, localHead)
assert.equal(await git(bareRemote, ['rev-parse', 'refs/heads/main']), localHead)
```

Also assert that no configured remote returns `local_only`, a missing target can be created, a non-fast-forward push is rejected with `retryKind: 'remote'`, and `ext::` or relative remote URLs are refused before the injected runner observes `ls-remote`, `fetch`, or `push`.

- [ ] **Step 2: Run the helper tests and verify RED**

Run: `node --test host/landing-remote.test.mjs`

Expected: FAIL because `host/landing-remote.mjs` and `LandingRemotePublisher` do not exist.

- [ ] **Step 3: Export the existing remote guard and implement the helper**

Change the existing private declaration in `host/git.mjs` to:

```js
export async function validateConfiguredRemote(repositoryPath, remote, purpose, options = {}) {
```

Implement `LandingRemotePublisher` with `runGit` calls that always prepend `-c core.hooksPath=/dev/null`, set `GIT_TERMINAL_PROMPT=0` through the existing runner, and use these exact operations:

```js
await validateConfiguredRemote(repositoryPath, remote, 'fetch', runtime)
await validateConfiguredRemote(repositoryPath, remote, 'push', runtime)
// Resolve existence without mutating user refs.
git(['ls-remote', '--exit-code', remote, `refs/heads/${targetBranch}`])
// Capture into a unique tool-owned branch usable by agent-worktree sync.
git(['fetch', '--no-tags', remote,
  `refs/heads/${targetBranch}:refs/heads/ensync/landing-remotes/${id}`])
// Publish only the verified commit, never ambient HEAD.
git(['push', '--porcelain', remote,
  `${publishedSha}:refs/heads/${targetBranch}`])
// Verify the exact remote result.
git(['ls-remote', '--exit-code', remote, `refs/heads/${targetBranch}`])
```

Validate `targetBranch` with `git check-ref-format --branch`, require 40- or 64-hex SHAs, bound/redact Git failures through `gitFailureMessage`, tag network/rejection failures with `retryKind = 'remote'`, and delete only the exact generated local ref in `release()`.

- [ ] **Step 4: Run helper and Git workflow tests**

Run: `node --test host/landing-remote.test.mjs host/git.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the helper**

```bash
git add host/landing-remote.mjs host/landing-remote.test.mjs host/git.mjs
git commit -m "feat: add safe landing remote publisher"
```

---

### Task 2: Remote-aware FIFO integration

**Files:**
- Modify: `host/landing-integrator.mjs`
- Modify: `host/landing-integrator.test.mjs`

**Interfaces:**
- Consumes: the Task 1 `LandingRemotePublisher` interface.
- Produces: `LandingIntegrator.integrate()` results with existing `landedIds`, `retryIds`, `errors`, and new `remoteRetryIds`; an ID appears in `landedIds` only after remote confirmation when a remote exists.

- [ ] **Step 1: Write failing end-to-end landing tests**

Extend the integration fixture with a bare `origin` and add tests for:

```js
const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])
assert.deepEqual(result.landedIds, ['landing-1'])
assert.equal(await git(current.remote, ['rev-parse', 'refs/heads/main']), await git(current.repositoryPath, ['rev-parse', 'main']))
```

Add separate cases proving:

- remote-ahead history becomes an ancestor of local and remote `main`;
- diverged local/remote histories are reconciled without force;
- an injected first push race returns `retryIds` and `remoteRetryIds` without `landedIds`;
- a second invocation pushes an item already present on local `main` instead of treating local ancestry as remote completion;
- a repository without a remote preserves existing local-only behavior;
- the source chat worktree remains unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern='remote|push|local-only' host/landing-integrator.test.mjs`

Expected: FAIL because the integrator neither captures nor publishes a remote target.

- [ ] **Step 3: Inject and capture the remote publisher**

Add the dependency:

```js
this.remotePublisher = options.remotePublisher ?? new LandingRemotePublisher({
  gitRunner: this.gitRunner,
  gitExecutable: this.gitExecutable,
})
```

At the beginning of the train, call `capture({ repositoryPath, targetBranch: target }, { signal })`. Release its generated branch in `finally`.

- [ ] **Step 4: Reconcile the immutable remote head in isolation**

Before chat items, test whether `snapshot.sha` is already an ancestor of `originalHead`. When it is not, apply the generated remote branch through the same `client.sync()` and bounded conflict resolver used for an item. Supply a synthetic resolver item containing the real repository/project paths, `provider: 'codex'`, `branch: snapshot.branch`, and `savedSha: snapshot.sha`; require the captured remote SHA to be an ancestor afterward.

For every journal item, compute local and captured-remote ancestry separately. Only the pair `alreadyLocal && alreadyRemote` may complete without publication. After remote reconciliation, skip reapplying a saved SHA already present in the integration head, but retain that item in the accepted set so it cannot become `landed` before the final push.

- [ ] **Step 5: Push and verify before returning landed IDs**

If the verified integration head differs from `originalHead`, retain the existing guarded local publication and postchecks. Otherwise pin `publishedSha = originalHead` without creating an empty merge. Then:

```js
try {
  await this.remotePublisher.publish({ snapshot, publishedSha }, { signal: this.#signal() })
} catch (error) {
  for (const { item } of accepted) {
    retry(item, error.message)
    remoteRetryIds.add(item.id)
  }
  return resultFor(train, landedIds, retryIds, errors, publishedSha, remoteRetryIds)
}
```

Persist conversation checkpoints and add IDs to `landedIds` only after successful remote verification. Extend `resultFor()` to sort and return `remoteRetryIds`.

- [ ] **Step 6: Run all landing integrator tests**

Run: `node --test host/landing-remote.test.mjs host/landing-integrator.test.mjs`

Expected: PASS with no external network access.

- [ ] **Step 7: Commit remote-aware integration**

```bash
git add host/landing-integrator.mjs host/landing-integrator.test.mjs
git commit -m "feat: push verified landing trains"
```

---

### Task 3: Durable bounded remote retries

**Files:**
- Modify: `host/landing-coordinator.mjs`
- Modify: `host/landing-coordinator.test.mjs`

**Interfaces:**
- Consumes: `remoteRetryIds` from Task 2.
- Produces: configurable `remoteRetryDelays`, defaulting to `[0, 1_000, 5_000, 30_000, 120_000]`, with the final delay reused as the cap while the Host remains online.

- [ ] **Step 1: Write failing retry scheduling tests**

Add a coordinator test where the first integration returns:

```js
return {
  landedIds: [],
  retryIds: [train[0].id],
  remoteRetryIds: [train[0].id],
  errors: { [train[0].id]: 'The remote moved.' },
}
```

Assert the journal transitions `queued -> integrating -> retry -> integrating -> landed` without another enqueue or Host restart. Add a sibling test proving an ordinary conflict `retryIds` result with no `remoteRetryIds` does not spin. Add a cancellation test proving shutdown clears a scheduled timer and leaves the item durably retryable.

- [ ] **Step 2: Run the coordinator tests and verify RED**

Run: `node --test --test-name-pattern='remote retry|ordinary conflict|scheduled remote' host/landing-coordinator.test.mjs`

Expected: FAIL because normalized results discard `remoteRetryIds` and retry entries are not rescheduled.

- [ ] **Step 3: Preserve remote retry metadata and reschedule only those IDs**

Extend `normalizedResult()` with a train-bounded `remoteRetryIds` set. Give each repository state a `remoteRetryFailures` counter. After durable transition to `retry`, reinsert only IDs present in `remoteRetryIds`, set `state.recoveryDelayMs` from the configured sequence, and break the current drain so `finally` schedules the next attempt. Reset the counter after any integration result without remote retries.

Reuse the final configured delay after the array is exhausted. `shutdown()` clears the timer exactly as it does for persistence recovery. Existing content-conflict retries remain dormant until startup or a later completion.

- [ ] **Step 4: Run coordinator and journal tests**

Run: `node --test host/landing-coordinator.test.mjs host/landing-journal.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit retry behavior**

```bash
git add host/landing-coordinator.mjs host/landing-coordinator.test.mjs
git commit -m "feat: retry automatic remote publication"
```

---

### Task 4: Host wiring, durable documentation, and release verification

**Files:**
- Modify: `host/server.mjs`
- Modify: `host/server-integrations.test.mjs`
- Modify: `.relay/project.md`
- Modify: `.relay/architecture.md`
- Modify: `.relay/features/git-workflows.md`
- Modify: `/Users/mikeyhasson/.claude/projects/-Users-mikeyhasson-dev-relay/memory/git-workflows.md`
- Modify: `/Users/mikeyhasson/.claude/projects/-Users-mikeyhasson-dev-relay/memory/MEMORY.md`

**Interfaces:**
- Consumes: Task 1 publisher, Task 2 integrator contract, and Task 3 retry semantics.
- Produces: the production Host's automatic remote-confirmed landing behavior.

- [ ] **Step 1: Write a failing production-wiring test**

In `host/server-integrations.test.mjs`, construct the real default landing services with an injected local bare remote and assert a completed queued snapshot reaches both local and remote target refs. Assert the exposed journal item is not `landed` before the remote update.

- [ ] **Step 2: Run the wiring test and verify RED**

Run: `node --test host/server-integrations.test.mjs`

Expected: FAIL until `server.mjs` creates and injects the landing remote publisher through the default integrator path.

- [ ] **Step 3: Wire production dependencies**

Create one `LandingRemotePublisher` beside `LandingIntegrator` in `resolveLandingIntegrator()`, using the Host's Git executable/runner defaults. Keep dependency injection available for tests. Do not route automatic landing through the manual `/api/git/push` handler or its typed production confirmation.

- [ ] **Step 4: Update canonical project documentation and memory**

Record that configured remotes are fetched/reconciled/pushed as part of automatic landing, `landed` means remote-confirmed when a remote exists, no-force races retry automatically, and no-remote repositories remain local-only. Replace the prior statement that automatic landing stops at local publication; keep manual production-push confirmation documented as a separate Git-panel operation.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node --test host/landing-remote.test.mjs host/landing-integrator.test.mjs host/landing-coordinator.test.mjs host/landing-journal.test.mjs host/git.test.mjs host/server-integrations.test.mjs
npm run release:verify
git diff --check
```

Expected: all commands exit 0 with no failed tests or lint errors.

- [ ] **Step 6: Commit the completed feature**

```bash
git add host/server.mjs host/server-integrations.test.mjs .relay/project.md .relay/architecture.md .relay/features/git-workflows.md
git commit -m "feat: auto-push completed landing trains"
```

- [ ] **Step 7: Install and activate safely**

Run `node scripts/install-app.mjs` from clean `main`. Verify the signed installed bundle contains the new modules. Do not terminate a Host with active provider or landing work; activate through the existing idle-safe retirement/relaunch path, then confirm Host health and one temporary/local-remote smoke path before reporting completion.

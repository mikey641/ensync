# Bounded Overlap Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent slow cross-conversation overlap scans from delaying a finished provider run and leaving its conversation stuck on “Working.”

**Architecture:** Replace the overlap session’s unbounded promise chain with one drain operation that permits one active scan and at most one coalesced trailing scan. Keep `ChatRunService`’s terminal ordering unchanged so the Host still saves work and releases the protected workspace before publishing the terminal result.

**Tech Stack:** Node.js ES modules, `node:test`, Git subprocess fixtures.

## Global Constraints

- Keep one provider run per conversation workspace and preserve renewable lease ownership until cleanup completes.
- Preserve automatic fallback only for Host-verified pre-mutation failures; never replay after tool, command, file, or unknown activity.
- Preserve cross-conversation overlap warnings for active and completed-but-unlanded branches.
- Use platform-neutral Node.js behavior with equal macOS and Windows support.
- Do not add dependencies or change provider catalog behavior.
- Ensync Host owns commits, branch integration, and push; do not run those operations manually.

---

### Task 1: Bound overlap-session refresh work

**Files:**

- Modify: `host/workspace-overlap.mjs:251-338`
- Test: `host/workspace-overlap.test.mjs`
- Modify: `.relay/features/git-workflows.md`

**Interfaces:**

- Consumes: `WorkspaceOverlapMonitor.start(workspace, options)` and its returned `refresh(): Promise<Overlap[]>` and `stop(): Promise<void>` methods.
- Produces: the same public methods and overlap events, with a concurrency guarantee of one active refresh plus at most one trailing refresh.

- [x] **Step 1: Add test utilities and a failing coalescing regression test**

Add a local deferred-promise helper to `host/workspace-overlap.test.mjs`:

```js
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
```

Add a test that wraps the real Git runner, captures the injected interval callback, blocks the first post-start `git status`, fires the timer repeatedly, requests one explicit final refresh, and then releases the scan:

```js
test('slow polling coalesces repeated ticks into one trailing overlap refresh', async (context) => {
  const f = await fixture(context)
  let tick = null
  let blockRefreshes = false
  let refreshStatusCalls = 0
  const firstRefreshStarted = deferred()
  const releaseFirstRefresh = deferred()
  const monitor = new WorkspaceOverlapMonitor({
    pollMs: 1,
    setInterval: (callback) => {
      tick = callback
      return { unref() {} }
    },
    clearInterval: () => {},
    gitRunner: async (args, options) => {
      if (blockRefreshes && options.cwd === f.first.repositoryPath && args[0] === 'status') {
        refreshStatusCalls += 1
        if (refreshStatusCalls === 1) {
          firstRefreshStarted.resolve()
          await releaseFirstRefresh.promise
        }
      }
      return runGit(args, options)
    },
  })
  const session = await monitor.start(f.first, { jobId: 'job-coalesced-refresh' })
  context.after(() => session.stop())
  blockRefreshes = true

  tick()
  await firstRefreshStarted.promise
  for (let index = 0; index < 50; index += 1) tick()
  const finalRefresh = session.refresh()
  releaseFirstRefresh.resolve()
  await finalRefresh

  assert.equal(refreshStatusCalls, 2)
})
```

The assertion is the observable boundary contract: restoring the current unbounded chaining starts 51 additional Git scans and fails it.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='slow polling coalesces' host/workspace-overlap.test.mjs
```

Expected: FAIL because `refreshStatusCalls` exceeds `2`, proving timer ticks currently queue separate scans.

- [x] **Step 3: Implement a single bounded refresh drain**

In `WorkspaceOverlapMonitor.start`, replace the resolved `operation` chain with nullable `operation` state and a trailing flag:

```js
let operation = null
let refreshAgain = false
```

Keep `refreshNow` responsible for one real scan. Implement `refresh` as one shared drain promise:

```js
const refreshOnce = async () => {
  try {
    return await refreshNow()
  } catch (error) {
    if (!failureReported) {
      failureReported = true
      options.onEvent?.({
        type: 'notice',
        code: 'workspace_overlap_unavailable',
        message: `Ensync could not refresh cross-conversation file awareness: ${error instanceof Error ? error.message : 'unknown error'}. Protected workspace isolation remains active.`,
        at: new Date(this.#now()).toISOString(),
      })
    }
    return [...currentOverlaps.values()]
  }
}

const refresh = () => {
  if (stopped) return operation ?? Promise.resolve([...currentOverlaps.values()])
  if (operation) {
    refreshAgain = true
    return operation
  }
  refreshAgain = false
  operation = (async () => {
    let overlaps = await refreshOnce()
    if (refreshAgain && !stopped) {
      refreshAgain = false
      overlaps = await refreshOnce()
    }
    return overlaps
  }).finally(() => {
    refreshAgain = false
    operation = null
  })
  return operation
}
```

The single `if` is intentional: requests received during the trailing scan share that scan and do not schedule a third pass. Handling errors per scan lets an already queued trailing scan run even if the active scan fails.

Update `stop()` so it sets `stopped`, clears `refreshAgain`, clears the interval, waits only for `operation`, and then retains the existing token-checked record removal:

```js
stopped = true
refreshAgain = false
this.#clearInterval(timer)
await operation?.catch(() => {})
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test --test-name-pattern='slow polling coalesces' host/workspace-overlap.test.mjs
```

Expected: PASS with exactly two post-start status scans.

- [x] **Step 5: Add stop, trailing-bound, and failed-scan regression tests**

Add a second test using the same injected timer and blocked first scan. After firing repeated ticks, call `session.stop()` before releasing the scan. Assert that only one post-start status scan occurred and that the owned record no longer exists:

```js
test('stopping a slow overlap session suppresses trailing refreshes and removes its record', async (context) => {
  const f = await fixture(context)
  let tick = null
  let blockRefreshes = false
  let refreshStatusCalls = 0
  const firstRefreshStarted = deferred()
  const releaseFirstRefresh = deferred()
  const monitor = new WorkspaceOverlapMonitor({
    pollMs: 1,
    setInterval: (callback) => {
      tick = callback
      return { unref() {} }
    },
    clearInterval: () => {},
    gitRunner: async (args, options) => {
      if (blockRefreshes && options.cwd === f.first.repositoryPath && args[0] === 'status') {
        refreshStatusCalls += 1
        if (refreshStatusCalls === 1) {
          firstRefreshStarted.resolve()
          await releaseFirstRefresh.promise
        }
      }
      return runGit(args, options)
    },
  })
  const session = await monitor.start(f.first, { jobId: 'job-stopped-refresh' })
  blockRefreshes = true
  tick()
  await firstRefreshStarted.promise
  for (let index = 0; index < 50; index += 1) tick()

  const stopped = session.stop()
  releaseFirstRefresh.resolve()
  await stopped

  assert.equal(refreshStatusCalls, 1)
  const recordPath = join(f.commonGitDirectory, 'ensync', 'active-workspace-edits', 'aaaaaaaaaaaaaaaaaaaaaaaa.json')
await assert.rejects(readFile(recordPath, 'utf8'), (error) => error?.code === 'ENOENT')
})
```

Also block the trailing scan, fire repeated timer and explicit refresh requests while it is running, and assert that the shared operation still completes after exactly two scans. Make the active scan fail in a separate case and assert that its already queued trailing scan still runs while the advisory failure is reported once.

- [x] **Step 6: Run all overlap tests**

Run:

```bash
node --test host/workspace-overlap.test.mjs
```

Expected: all tests pass, including active overlap detection, deduplication, stale-record handling, unlanded-branch inspection, coalescing, and stop cleanup.

- [x] **Step 7: Document the durable scheduling rule**

Update `.relay/features/git-workflows.md` in **Cross-conversation edit awareness** to state that periodic overlap scans share one active operation plus one coalesced trailing refresh, and that terminal cleanup suppresses trailing polling so slow repositories cannot leave a completed provider run displayed as active.

- [x] **Step 8: Run focused and whole-task verification**

Run:

```bash
node --test host/workspace-overlap.test.mjs host/chat.test.mjs host/chat-jobs.test.mjs host/auto-context-fallback.test.mjs
npm run land:check
git diff --check
git status --short
```

Expected: the Node suites and `land:check` exit `0`; `git diff --check` reports nothing; status lists only the approved design, plan, overlap implementation/test, and focused feature-memory update.

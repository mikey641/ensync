# Local Update Now With Restart-Surviving Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-development **Update now** action that installs the newest clean landed `main`, restarts the Electron shell and Host daemon, and reconnects to the same still-running provider processes afterward.

**Architecture:** Move provider-process ownership into one detached, authenticated worker per active job while the replaceable Host remains the renderer-facing gateway. Build a complete local app candidate before shutdown, use a detached helper to atomically promote or roll it back, then let the new Host discover and reattach compatible workers before accepting new starts.

**Tech Stack:** Node.js 20+ ESM, Electron 43, React/TypeScript, loopback HTTP/NDJSON, atomic JSON journals, Git, `node:test`, electron-builder packaging.

## Global Constraints

- This path is for local `dev` builds only; signed beta/stable releases and Microsoft Store updates retain their current behavior.
- Keep `desktop/package.json` product SemVer unchanged. Display local builds as `<product-version>-dev.<first-parent-count>+g<12-char-sha>`.
- **Update now** is explicit. Landing advertises a newer candidate but never restarts the app automatically.
- An active job must retain its original job ID, provider PID, request hash, event sequence, and loaded worker code across a Host restart. Never submit its prompt again.
- The renderer supplies no executable, source path, Git revision, update path, process ID, port, token, or command arguments.
- Provider routing remains subscription-only and uses the existing sanitized environment and fixed provider arguments.
- The Host remains the only process allowed to publish landing work. A worker may persist an exact saved branch SHA for later idempotent import.
- Worker and updater descriptors are bounded, checksummed, atomically replaced, and user-only (`0600` on POSIX; user-scoped ACL behavior on Windows).
- PID ownership is verified with process start time. PID liveness alone is never authoritative.
- macOS and Windows use the same state machines and protocols. Platform adapters are limited to process inspection, bundle promotion/signing, and launching. Store-managed Windows installs never enter the local updater.
- Preserve the conversation-first interface, stable `ensync://app` origin, per-window storage identities, detached-job reconnection, safe pre-mutation fallback, and no-force Git behavior.

---

## File structure

New focused modules:

- `host/job-worker-state.mjs` — worker descriptor/journal validation and atomic persistence.
- `host/job-worker-server.mjs` — authenticated single-job loopback server and event/control API.
- `host/job-worker-client.mjs` — Host-side authenticated worker transport.
- `host/job-worker-manager.mjs` — spawn, discovery, reattachment, ownership, and terminal acknowledgement.
- `host/job-worker-entry.mjs` — production construction of local/SSH run services inside a worker.
- `desktop/src/job-worker-bootstrap.mjs` — dependency-free detached worker bootstrap.
- `host/local-update-candidates.mjs` — last-landed candidate persistence for the configured Ensync source checkout.
- `desktop/src/local-dev-update.mjs` — native update state machine and fixed orchestration API.
- `desktop/src/local-dev-update-helper.mjs` — detached promotion/rollback/relaunch process.
- `src/components/LocalDevelopmentUpdate.tsx` — Settings UI for the local action.
- `src/lib/localDevelopmentUpdate.mjs` and `.d.mts` — renderer bridge wrapper and types.

Existing modules retain their current responsibilities:

- `host/chat.mjs` prepares/runs work and persists one exact saved-work handoff.
- `host/chat-jobs.mjs` remains the renderer-visible retained-job registry but delegates execution to an executor interface.
- `host/project-isolation.mjs` prepares the workspace and can adopt a verified live worker after Host restart.
- `host/landing-*` remains the only target-branch integration path.
- `desktop/src/main.mjs`, `preload.cjs`, and `runtime.mjs` expose fixed IPC and coordinate Host shutdown/restart.
- `scripts/install-app.mjs` stages a complete local application instead of mutating the live bundle piecemeal.

---

### Task 1: Deterministic development build identity

**Files:**
- Modify: `desktop/src/build-info.mjs`
- Modify: `desktop/scripts/write-build-info.mjs`
- Modify: `desktop/test/build-info.test.mjs`
- Modify: `desktop/src/native-updates.mjs`
- Modify: `desktop/test/native-updates.test.mjs`
- Modify: `src/lib/nativeUpdates.d.mts`
- Modify: `src/components/NativeUpdatePreferences.tsx`

**Interfaces:**
- Produces: `developmentDisplayVersion(appVersion, commitCount, sourceCommit): string`
- Produces: build-info schema v2 with `displayVersion: string | null`; schema v1 remains readable.

- [ ] **Step 1: Write failing build-identity tests**

Add tests that name the production behavior directly:

```js
test('developmentDisplayVersion identifies one commit without changing product SemVer', () => {
  assert.equal(
    developmentDisplayVersion('0.1.0', 412, sourceCommit),
    `0.1.0-dev.412+g${sourceCommit.slice(0, 12)}`,
  )
})

test('build info v2 validates its development display version and still reads v1', () => {
  const v2 = createBuildInfo({
    appVersion: '0.1.0', channel: 'dev', sourceCommit,
    sourceDirty: false, builtAt: '2026-09-03T10:00:00.000Z', commitCount: 412,
  })
  assert.equal(v2.schemaVersion, 2)
  assert.equal(v2.displayVersion, `0.1.0-dev.412+g${sourceCommit.slice(0, 12)}`)
  assert.equal(normalizeBuildInfo(v2, { expectedVersion: '0.1.0' })?.buildId, v2.buildId)
  assert.equal(normalizeBuildInfo(v1Fixture)?.displayVersion, null)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test desktop/test/build-info.test.mjs`

Expected: FAIL because `developmentDisplayVersion` is not exported and schema v2 is not produced.

- [ ] **Step 3: Implement schema-compatible version generation**

Use strict inputs and include the display version in the v2 build hash:

```js
export function developmentDisplayVersion(appVersion, commitCount, sourceCommit) {
  if (typeof appVersion !== 'string' || !appVersion.trim()) throw new TypeError('A build version is required.')
  if (!Number.isSafeInteger(commitCount) || commitCount < 1) throw new TypeError('A positive Git commit count is required.')
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit ?? '')) throw new TypeError('The exact source commit is required.')
  return `${appVersion.trim()}-dev.${commitCount}+g${sourceCommit.toLowerCase().slice(0, 12)}`
}
```

`createBuildInfo` emits schema v2. It requires `commitCount` only for `dev`, sets `displayVersion` to `null` for beta/stable, and `normalizeBuildInfo` recomputes either the legacy v1 hash or v2 hash according to the input schema.

In `collectBuildInfo`, obtain the count with an argument-array Git call:

```js
const commitCount = channel === 'dev'
  ? Number.parseInt(gitOutput(['rev-list', '--first-parent', '--count', sourceCommit], repoRoot), 10)
  : null
```

Add `installedDisplayVersion` to the frozen native-update state and set it from
`installedBuildInfo.displayVersion ?? installedVersion`. Show that field in the current Settings copy without
changing signed update comparisons, which continue to use `installedVersion`.

- [ ] **Step 4: Verify GREEN and compatibility**

Run: `node --test desktop/test/build-info.test.mjs desktop/test/native-updates.test.mjs`

Expected: all tests PASS; stable/beta update ordering still compares product SemVer.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/build-info.mjs desktop/scripts/write-build-info.mjs desktop/test/build-info.test.mjs desktop/src/native-updates.mjs desktop/test/native-updates.test.mjs src/lib/nativeUpdates.d.mts src/components/NativeUpdatePreferences.tsx
git commit -m "feat: identify local builds by landed revision"
```

---

### Task 2: Idempotent saved-work import into automatic landing

**Files:**
- Modify: `host/landing-journal.mjs`
- Modify: `host/landing-coordinator.mjs`
- Modify: `host/landing-journal.test.mjs`
- Modify: `host/landing-coordinator.test.mjs`

**Interfaces:**
- Produces: `LandingJournal.enqueueUnique(input): Promise<{ item, inserted }>`
- Produces: `LandingCoordinator.enqueue(input)` returning the existing item for duplicate `commonGitDirectory + savedSha + targetBranch` input.

- [ ] **Step 1: Write failing duplicate-import tests**

```js
test('enqueueUnique returns one durable landing item for a repeated worker handoff', async (t) => {
  const journal = await fixtureJournal(t)
  const first = await journal.enqueueUnique(validLandingInput())
  const second = await journal.enqueueUnique(validLandingInput())
  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
  assert.equal(second.item.id, first.item.id)
  assert.equal((await journal.load()).length, 1)
})

test('coordinator schedules a repeated saved-work handoff only once', async (t) => {
  const { coordinator, integrated, input } = await coordinatorFixture(t)
  const first = await coordinator.enqueue(input)
  const second = await coordinator.enqueue({ ...input })
  await coordinator.whenIdle()
  assert.equal(first.id, second.id)
  assert.deepEqual(integrated.flatMap((train) => train.map((item) => item.id)), [first.id])
})
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test host/landing-journal.test.mjs host/landing-coordinator.test.mjs`

Expected: FAIL because `enqueueUnique` is missing and duplicate coordinator input creates two records.

- [ ] **Step 3: Implement atomic deduplication inside the journal write chain**

Use the already-serialized journal operation; never check outside it:

```js
const landingIdentity = (input) => [
  normalizedPath(input.commonGitDirectory),
  input.savedSha.toLowerCase(),
  input.targetBranch,
].join('\0')

enqueueUnique(input = {}) {
  return this.#serialize(async () => {
    if (!this.loaded) await this.#loadFromDisk()
    const existing = this.items.find((item) => landingIdentity(item) === landingIdentity(input))
    if (existing) return { item: cloneItem(existing), inserted: false }
    const item = this.#normalizedNewItem(input)
    await this.#save([...this.items, item], this.nextSequence + 1)
    return { item: cloneItem(item), inserted: true }
  })
}
```

Make `LandingCoordinator.enqueue` anchor the immutable SHA, call `enqueueUnique`, and call `#markReady` only when inserted or when the returned item is in `queued`/`retry` and absent from the in-memory ready map.

- [ ] **Step 4: Verify GREEN**

Run: `node --test host/landing-journal.test.mjs host/landing-coordinator.test.mjs`

Expected: all tests PASS with one integration attempt for a repeated handoff.

- [ ] **Step 5: Commit**

```bash
git add host/landing-journal.mjs host/landing-coordinator.mjs host/landing-journal.test.mjs host/landing-coordinator.test.mjs
git commit -m "feat: import saved landing work idempotently"
```

---

### Task 3: Worker descriptor and journal persistence

**Files:**
- Create: `host/job-worker-state.mjs`
- Create: `host/job-worker-state.test.mjs`
- Reuse: `host/process-liveness.mjs`

**Interfaces:**
- Produces: `createWorkerDescriptor(input): WorkerDescriptor`
- Produces: `readWorkerDescriptor(path, options): Promise<WorkerDescriptor | null>`
- Produces: `JobWorkerJournal({ filePath, writer, limits }).load()/save()/appendEvent()/complete()/acknowledge()`

- [ ] **Step 1: Write failing validation and recovery tests**

Cover checksums, bounded events, terminal saved-work, atomic backup recovery, file mode, and writer fencing:

```js
test('worker descriptor requires token, request hash, PID start time, and compatible protocol', () => {
  const descriptor = createWorkerDescriptor(validDescriptorInput())
  assert.equal(descriptor.protocolVersion, 1)
  assert.match(descriptor.token, /^[a-f0-9]{64}$/)
  assert.equal(normalizeWorkerDescriptor({ ...descriptor, requestHash: 'bad' }), null)
  assert.equal(normalizeWorkerDescriptor({ ...descriptor, startedAt: 'bad' }), null)
})

test('worker journal recovers terminal result and saved work from backup exactly once', async (t) => {
  const journal = await workerJournalFixture(t)
  await journal.appendEvent({ type: 'started', at: now })
  await journal.complete({ result: fakeResult, savedWork: validLandingInput() })
  await corruptPrimary(journal.filePath)
  const recovered = await new JobWorkerJournal(journal.options).load()
  assert.equal(recovered.state, 'completed')
  assert.deepEqual(recovered.savedWork, validLandingInput())
  assert.deepEqual(recovered.events.map((event) => event.sequence), [1])
})
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test host/job-worker-state.test.mjs`

Expected: FAIL because `job-worker-state.mjs` does not exist.

- [ ] **Step 3: Implement bounded schema-v1 state**

Define exact constants:

```js
export const JOB_WORKER_PROTOCOL_VERSION = 1
export const JOB_WORKER_MINIMUM_PROTOCOL_VERSION = 1
const MAX_EVENTS = 1_000
const MAX_EVENT_CHARACTERS = 2 * 1024 * 1024
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/
```

Persist `{version:1, checksum, payload}` through `file.staging -> file`, preserving `file.backup`; call `chmod(0o600)` best-effort on Windows and strictly on POSIX. Store the job ID, kind, request hash, provider, worker instance/PID/start time/build ID, state, bounded public events, terminal result, exact `savedWork`, and acknowledgement flag. Never persist the prompt or request.

- [ ] **Step 4: Verify GREEN**

Run: `node --test host/job-worker-state.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add host/job-worker-state.mjs host/job-worker-state.test.mjs
git commit -m "feat: persist restart-surviving job worker state"
```

---

### Task 4: Authenticated single-job worker server

**Files:**
- Create: `host/job-worker-server.mjs`
- Create: `host/job-worker-server.test.mjs`
- Create: `desktop/src/job-worker-bootstrap.mjs`
- Modify: `desktop/test/host-bootstrap-lifecycle.test.mjs`

**Interfaces:**
- Consumes: Task 3 worker descriptor/journal schemas.
- Produces: `startJobWorkerServer({ job, journal, run, cancel, steer, answer, pendingQuestions, canSteer, token, instanceId }): http.Server`
- Produces worker routes: `GET /health`, `GET /job`, `GET /events?after=`, `POST /cancel`, `POST /steer`, `POST /answer`, `POST /acknowledge`.

- [ ] **Step 1: Write failing server tests with one blocking fake run**

```js
test('worker survives subscriber disconnect and returns missing events after reconnect', async (t) => {
  let releaseRun
  const gate = new Promise((resolve) => { releaseRun = resolve })
  const worker = await workerServerFixture(t, async ({ onEvent }) => {
    onEvent({ type: 'started', at: now })
    await gate
    return fakeResult
  })
  assert.equal((await worker.get('/health')).status, 401)
  const first = await worker.authorizedGet('/events?after=0')
  assert.equal(first.events[0].sequence, 1)
  releaseRun()
  await worker.untilTerminal()
  const second = await worker.authorizedGet('/events?after=1')
  assert.equal(second.events.at(-1).type, 'completed')
})
```

Also assert that duplicate steer idempotency keys deliver once, unknown methods return JSON 404, request bodies are bounded, and acknowledgement is accepted only after terminal persistence.

- [ ] **Step 2: Run and verify RED**

Run: `node --test host/job-worker-server.test.mjs desktop/test/host-bootstrap-lifecycle.test.mjs`

Expected: FAIL because the worker server/bootstrap is absent.

- [ ] **Step 3: Implement the dependency-free worker transport**

Authorize with timing-safe bearer comparison and return snapshots rather than exposing internal handles:

```js
if (!bearerAuthorized(request.headers.authorization, token)) {
  return sendJson(response, 401, { error: 'Worker authentication failed.', code: 'worker_authentication_failed' })
}
if (request.method === 'GET' && url.pathname === '/health') {
  return sendJson(response, 200, {
    ok: true, service: 'ensync-job-worker', protocolVersion: 1,
    minimumProtocolVersion: 1, instanceId, jobId: job.id, requestHash: job.requestHash,
  })
}
```

The bootstrap accepts only absolute `ENSYNC_JOB_WORKER_ENTRY`, `ENSYNC_JOB_WORKER_BOOTSTRAP`, `ENSYNC_JOB_WORKER_DESCRIPTOR`, and `ENSYNC_JOB_WORKER_JOURNAL` paths plus a 64-hex token. It reads the user-only bootstrap request, verifies its hash, deletes that file before provider execution, imports the fixed entry module, and writes its descriptor only after listening.

- [ ] **Step 4: Verify GREEN**

Run: `node --test host/job-worker-server.test.mjs desktop/test/host-bootstrap-lifecycle.test.mjs`

Expected: all tests PASS and the bootstrap contains no provider-specific code.

- [ ] **Step 5: Commit**

```bash
git add host/job-worker-server.mjs host/job-worker-server.test.mjs desktop/src/job-worker-bootstrap.mjs desktop/test/host-bootstrap-lifecycle.test.mjs
git commit -m "feat: serve detached job workers over authenticated loopback"
```

---

### Task 5: Worker client, discovery, and workspace ownership adoption

**Files:**
- Create: `host/job-worker-client.mjs`
- Create: `host/job-worker-client.test.mjs`
- Create: `host/job-worker-manager.mjs`
- Create: `host/job-worker-manager.test.mjs`
- Modify: `host/project-isolation.mjs`
- Modify: `host/project-isolation.test.mjs`

**Interfaces:**
- Consumes: worker protocol from Tasks 3–4.
- Produces: `JobWorkerClient.connect(descriptor)` and `eventsAfter/cancel/steer/answer/acknowledge`.
- Produces: `JobWorkerManager.initialize()/start()/recover()/handle()/detach()/shutdown()`.
- Produces: `ProjectIsolationService.adopt(workspace, owner): { disposition, lease }`.

- [ ] **Step 1: Write failing authenticity, recovery, and adoption tests**

```js
test('manager adopts one live matching worker and rejects a reused PID descriptor', async (t) => {
  const fixture = await managerFixture(t)
  await fixture.writeDescriptor({ ...fixture.valid, pid: fixture.livePid, startedAt: fixture.liveStartedAt })
  const recovered = await fixture.manager.initialize()
  assert.deepEqual(recovered.map((item) => item.jobId), [fixture.valid.jobId])

  await fixture.writeDescriptor({ ...fixture.valid, pid: fixture.reusedPid, startedAt: fixture.oldStartedAt })
  assert.deepEqual(await fixture.freshManager().initialize(), [])
})

test('project isolation adopts a verified worker owner and blocks a duplicate conversation', async (t) => {
  const { service, workspace, request } = await preparedWorkspaceFixture(t)
  const adopted = await service.adopt(workspace, { jobId: 'worker_job_12345678' })
  assert.equal(adopted.disposition, 'acquired')
  const duplicate = await service.tryAcquireOrDescribe(request.projectPath, request.workspaceKey)
  assert.equal(duplicate.disposition, 'occupied')
  await adopted.lease.release()
})
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test host/job-worker-client.test.mjs host/job-worker-manager.test.mjs host/project-isolation.test.mjs`

Expected: FAIL because the manager/client and `adopt` API are absent.

- [ ] **Step 3: Implement strict discovery and manager lifecycle**

Compute the same ownership key for prepared and adopted workspaces:

```js
#ownershipKey(commonGitDirectory, rawWorkspaceKey) {
  return `${normalizePlatformPath(commonGitDirectory, this.#platform)}\0${digest(workspaceKey(rawWorkspaceKey))}`
}
```

`adopt` verifies absolute workspace paths, canonical common-Git-directory identity, existing worktree/branch, and the exact workspace key recorded in the worker descriptor before inserting into `#active`.

The manager scans only immediate descriptor children of its configured root. For each descriptor it verifies schema, `processIsLiveSince`, authenticated health, exact instance/job/request identity, and protocol overlap:

```js
const compatible = health.minimumProtocolVersion <= HOST_WORKER_PROTOCOL_VERSION
  && health.protocolVersion >= HOST_MINIMUM_WORKER_PROTOCOL_VERSION
if (!compatible) return { state: 'incompatible', descriptor, health }
```

`start` writes a mode-`0600` bootstrap file, spawns the fixed Electron/Node executable with `detached:true`, `shell:false`, `stdio:'ignore'`, waits for the descriptor, deletes the bootstrap on failure, and never logs request contents or the token.

- [ ] **Step 4: Verify GREEN**

Run: `node --test host/job-worker-client.test.mjs host/job-worker-manager.test.mjs host/project-isolation.test.mjs`

Expected: all tests PASS, including Windows path-case fixtures.

- [ ] **Step 5: Commit**

```bash
git add host/job-worker-client.mjs host/job-worker-client.test.mjs host/job-worker-manager.mjs host/job-worker-manager.test.mjs host/project-isolation.mjs host/project-isolation.test.mjs
git commit -m "feat: discover and adopt live job workers"
```

---

### Task 6: Durable saved-work handoff from ChatRunService

**Files:**
- Modify: `host/chat.mjs`
- Modify: `host/chat.test.mjs`
- Create: `host/job-worker-entry.mjs`
- Create: `host/job-worker-entry.test.mjs`

**Interfaces:**
- Consumes: Task 2 idempotent landing and Tasks 3–5 worker runtime.
- Produces: `completionSink.persist(savedWork): Promise<{ completionSequence?: number }>` option on `ChatRunService`.
- Produces: `startJobWorker(input, runtime)` used by the worker bootstrap.

- [ ] **Step 1: Write failing completion-sink tests**

```js
test('a successful run is not terminal until exact saved work is durable in its completion sink', async () => {
  const persisted = []
  const service = chatFixture({
    completionSink: { persist: async (savedWork) => persisted.push(savedWork) },
  })
  const result = await service.run(validRequest(), runOptions())
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].savedSha, await protectedHead(result.workspace.repositoryPath))
})

test('a worker terminal result retains saved work until Host acknowledgement', async (t) => {
  const worker = await productionWorkerFixture(t, successfulFakeProvider())
  await worker.untilTerminal()
  assert.match(worker.journal().savedWork.savedSha, /^[a-f0-9]{40}$/)
  assert.equal(worker.journal().acknowledged, false)
})
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test host/chat.test.mjs host/job-worker-entry.test.mjs`

Expected: FAIL because `completionSink` and the production worker entry do not exist.

- [ ] **Step 3: Replace direct landing dependency with a durable sink**

Keep the current Host behavior through an adapter:

```js
const completionSink = options.completionSink ?? (
  options.landingCoordinator
    ? { persist: (savedWork) => options.landingCoordinator.enqueue(savedWork) }
    : null
)
```

After `commitAgentWork` returns its exact `savedHead`, build one frozen `savedWork` object and `await completionSink.persist(savedWork)`. Preserve the current `automatic_landing_queue_failed` failure if no durable sink accepts successful work.

`startJobWorker` constructs `ProviderStatusService`, `ProjectIsolationService`, `ChatRunService`, and `RemoteSshService` inside the worker. It passes a synthetic pre-acquired lease containing the Host-prepared serialized workspace; that lease's abort signal is worker-owned, and `assertHeld` verifies only the worker runtime's live ownership token. Its completion sink writes `savedWork` into the worker journal. It exposes existing Codex steer and Claude/Droid question controls through the worker server callbacks.

- [ ] **Step 4: Verify GREEN**

Run: `node --test host/chat.test.mjs host/job-worker-entry.test.mjs host/job-worker-server.test.mjs`

Expected: all tests PASS; the existing inline Host adapter still queues landing normally.

- [ ] **Step 5: Commit**

```bash
git add host/chat.mjs host/chat.test.mjs host/job-worker-entry.mjs host/job-worker-entry.test.mjs
git commit -m "feat: persist completed agent work through worker handoffs"
```

---

### Task 7: Make ChatJobService a recoverable worker-backed registry

**Files:**
- Modify: `host/chat-jobs.mjs`
- Modify: `host/chat-job-journal.mjs`
- Modify: `host/chat-jobs.test.mjs`
- Modify: `host/host-job-recovery.test.mjs`
- Modify: `host/server.mjs`
- Modify: `host/server-integrations.test.mjs`

**Interfaces:**
- Consumes: `JobWorkerManager` and `completionSink` from earlier tasks.
- Produces: `ChatJobService.initialize(): Promise<void>`.
- Produces: `ChatJobService.shutdown({ preserveWorkers?: boolean }): Promise<void>`.
- Produces: journal fields `workerInstanceId`, `workerBuildId`, and serialized workspace ownership metadata for running jobs.

- [ ] **Step 1: Write failing Host-restart recovery tests**

```js
test('Host restart reattaches the same worker instead of orphaning or replaying the request', async (t) => {
  const worker = blockingWorkerFixture(t)
  const first = await hostFixture(t, { workerManager: worker.manager() })
  const started = await first.chatJobs.start(worker.input)
  const pid = worker.providerPid()
  await first.chatJobs.shutdown({ preserveWorkers: true })

  const second = await hostFixture(t, { workerManager: worker.manager() })
  await second.chatJobs.initialize()
  assert.equal(second.chatJobs.get(started.job.id).state, 'running')
  assert.equal(worker.providerPid(), pid)
  assert.equal(worker.startCount(), 1)
})

test('recovered terminal saved work is enqueued once before worker acknowledgement', async (t) => {
  const fixture = completedUnacknowledgedWorkerFixture(t)
  const host = await hostFixture(t, fixture.options)
  await host.chatJobs.initialize()
  assert.equal(fixture.landingInputs.length, 1)
  assert.equal(fixture.worker.acknowledgements, 1)
  await host.chatJobs.initialize()
  assert.equal(fixture.landingInputs.length, 1)
})
```

Also test that ordinary `shutdown()` still cancels workers, `preserveWorkers:true` does not, start is rejected until `initialize()` finishes, and incompatible live workers remain visible as non-replayable recovery errors without termination.

- [ ] **Step 2: Run and verify RED**

Run: `node --test host/chat-jobs.test.mjs host/host-job-recovery.test.mjs host/server-integrations.test.mjs`

Expected: FAIL because restored running jobs are immediately orphaned and shutdown always aborts them.

- [ ] **Step 3: Add executor-backed start/recovery without changing public job routes**

The default inline executor keeps unit tests and browser development compatible. Packaged Host construction supplies the worker manager. Gate public methods on initialization:

```js
async initialize() {
  if (this.#ready) return this.#ready
  this.#ready = this.#recoverWorkers()
  return this.#ready
}

async shutdown({ preserveWorkers = false } = {}) {
  this.#shuttingDown = true
  this.#flushPersist()
  if (preserveWorkers) return this.#executor.detach()
  await this.#executor.shutdown()
}
```

On worker terminal, append unseen events, durably enqueue `savedWork`, durably store the terminal Host event, release/adopted workspace ownership, then acknowledge. On restart, do these same steps in the same order. A crash between any two steps repeats idempotently through Task 2 and the worker acknowledgement flag.

In `createEnsyncHost`, construct `JobWorkerManager` only when absolute worker bootstrap/entry/state paths are provided. Await `chatJobs.initialize()` and `landingCoordinator.start()` through a new `server.ensyncReady` promise before `listen()` in the daemon bootstrap.

- [ ] **Step 4: Verify GREEN**

Run: `node --test host/chat-jobs.test.mjs host/host-job-recovery.test.mjs host/server-integrations.test.mjs`

Expected: all tests PASS and every existing `/api/chat/jobs` route retains its response schema.

- [ ] **Step 5: Commit**

```bash
git add host/chat-jobs.mjs host/chat-job-journal.mjs host/chat-jobs.test.mjs host/host-job-recovery.test.mjs host/server.mjs host/server-integrations.test.mjs
git commit -m "feat: reconnect Host jobs to surviving workers"
```

---

### Task 8: Package and launch job workers on macOS and Windows

**Files:**
- Modify: `desktop/src/main.mjs`
- Modify: `desktop/src/runtime.mjs`
- Modify: `desktop/src/host-bootstrap.mjs`
- Modify: `desktop/package.json`
- Modify: `desktop/scripts/package-native.mjs`
- Modify: `scripts/install-app.mjs`
- Modify: `desktop/test/runtime.test.mjs`
- Modify: `desktop/test/install-app-asar.test.mjs`
- Create: `desktop/test/package-native.test.mjs`

**Interfaces:**
- Consumes: Task 4 bootstrap and Task 6 entry.
- Produces Host environment: `ENSYNC_JOB_WORKER_BOOTSTRAP`, `ENSYNC_JOB_WORKER_ENTRY`, `ENSYNC_JOB_WORKER_STATE_ROOT`, `ENSYNC_APP_BUILD_ID`.

- [ ] **Step 1: Write failing runtime/package tests**

```js
test('packaged runtime passes fixed absolute worker paths to the Host', () => {
  const paths = runtimePathsFor('/Applications/Ensync.app/Contents/Resources')
  assert.equal(paths.jobWorkerBootstrapPath, join(paths.resources, 'job-worker-bootstrap.mjs'))
  assert.equal(paths.jobWorkerEntryPath, join(paths.resources, 'host', 'job-worker-entry.mjs'))
})

test('local install stages worker bootstrap and entry with the complete Host payload', async (t) => {
  const candidate = await stagedInstallFixture(t)
  assert.equal(await exists(join(candidate.resources, 'job-worker-bootstrap.mjs')), true)
  assert.equal(await exists(join(candidate.resources, 'host', 'job-worker-entry.mjs')), true)
})
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test desktop/test/runtime.test.mjs desktop/test/install-app-asar.test.mjs desktop/test/package-native.test.mjs`

Expected: FAIL because worker paths are not packaged or forwarded.

- [ ] **Step 3: Wire exact packaged paths**

Add the bootstrap as an explicit `extraResources` mapping and keep the entry inside the existing filtered `host/` copy. In `runtimePaths()` return absolute worker paths for packaged and source modes. Pass them to `HostProcessController`, which adds them to the daemon environment only after `access()` verifies every file.

In `host-bootstrap.mjs`, validate the three worker paths as absolute and pass them plus the current build ID to `startEnsyncHost`. Do not import worker code into the gateway bootstrap.

Update `install-app.mjs` to copy the worker bootstrap beside `desktop-host-bootstrap.mjs`; the Host rsync already carries `job-worker-entry.mjs`.

- [ ] **Step 4: Verify GREEN and native syntax**

Run: `node --test desktop/test/runtime.test.mjs desktop/test/install-app-asar.test.mjs desktop/test/package-native.test.mjs && node --check desktop/src/job-worker-bootstrap.mjs && node --check host/job-worker-entry.mjs`

Expected: all tests and syntax checks PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main.mjs desktop/src/runtime.mjs desktop/src/host-bootstrap.mjs desktop/package.json desktop/scripts/package-native.mjs scripts/install-app.mjs desktop/test/runtime.test.mjs desktop/test/install-app-asar.test.mjs desktop/test/package-native.test.mjs
git commit -m "build: package restart-surviving job workers"
```

---

### Task 9: Local landed-candidate and update transaction state

**Files:**
- Create: `host/local-update-candidates.mjs`
- Create: `host/local-update-candidates.test.mjs`
- Modify: `host/landing-coordinator.mjs`
- Modify: `host/server.mjs`
- Modify: `host/server-integrations.test.mjs`
- Create: `desktop/src/local-dev-update.mjs`
- Create: `desktop/test/local-dev-update.test.mjs`

**Interfaces:**
- Produces: `LocalUpdateCandidateStore.recordLanding(event)/status(installedBuildInfo)`.
- Produces Host routes: `GET /api/local-updates/status`, `POST /api/local-updates/prepare-daemon-restart`.
- Produces: `createLocalDevelopmentUpdateManager(options)` with `state()`, `check()`, and `updateNow()`.

- [ ] **Step 1: Write failing candidate and state-machine tests**

```js
test('only a landed event for the configured Ensync source becomes an update candidate', async (t) => {
  const store = await candidateStoreFixture(t, { sourceRoot: ensyncRoot })
  await store.recordLanding({ type: 'retry', item: landedItem(ensyncRoot, sha2) })
  await store.recordLanding({ type: 'landed', item: landedItem(otherRoot, sha2) })
  assert.equal((await store.status(buildInfoAt(sha1))).available, false)
  await store.recordLanding({ type: 'landed', item: landedItem(ensyncRoot, sha2) })
  assert.equal((await store.status(buildInfoAt(sha1))).sourceCommit, sha2)
})

test('Update now pins one clean main revision and deduplicates repeated clicks', async () => {
  const fixture = localUpdateFixture({ sourceHead: sha2, installedHead: sha1, clean: true })
  const [left, right] = await Promise.all([fixture.manager.updateNow(), fixture.manager.updateNow()])
  assert.equal(left.transactionId, right.transactionId)
  assert.equal(fixture.stageCalls[0].sourceCommit, sha2)
})
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test host/local-update-candidates.test.mjs host/server-integrations.test.mjs desktop/test/local-dev-update.test.mjs`

Expected: FAIL because candidate persistence, routes, and local update state do not exist.

- [ ] **Step 3: Implement candidate validation and pre-shutdown phases**

The candidate store accepts only an exact `landed` event whose canonical real path equals the install-time source root and whose SHA equals the target branch head. It persists only source root hash, full SHA, target branch, commit count, and observation time; the API returns no absolute source path.

The native manager exposes exact phases:

```js
const LOCAL_UPDATE_PHASES = new Set([
  'checking', 'unavailable', 'up_to_date', 'available',
  'verifying', 'staging', 'ready_to_restart', 'restarting',
  'reconnecting', 'complete', 'error',
])
```

`updateNow()` requests status, pins the returned SHA, runs one injected `stageCandidate({sourceCommit})`, persists the transaction, and stops before shutdown if Git is dirty, branch is not `main`, the SHA moved during verification, the installed build is not `dev`, or Store management is active.

- [ ] **Step 4: Verify GREEN**

Run: `node --test host/local-update-candidates.test.mjs host/server-integrations.test.mjs desktop/test/local-dev-update.test.mjs`

Expected: all tests PASS; no route returns the source path.

- [ ] **Step 5: Commit**

```bash
git add host/local-update-candidates.mjs host/local-update-candidates.test.mjs host/landing-coordinator.mjs host/server.mjs host/server-integrations.test.mjs desktop/src/local-dev-update.mjs desktop/test/local-dev-update.test.mjs
git commit -m "feat: track verified local update candidates"
```

---

### Task 10: Atomic staged promotion helper and daemon handoff

**Files:**
- Create: `desktop/src/local-dev-update-helper.mjs`
- Create: `desktop/test/local-dev-update-helper.test.mjs`
- Modify: `desktop/src/local-dev-update.mjs`
- Modify: `desktop/test/local-dev-update.test.mjs`
- Modify: `desktop/src/host-bootstrap.mjs`
- Modify: `desktop/test/host-bootstrap-lifecycle.test.mjs`
- Modify: `host/server.mjs`
- Modify: `host/chat-jobs.mjs`
- Modify: `scripts/install-app.mjs`
- Create: `scripts/install-app.test.mjs`

**Interfaces:**
- Produces: `stageLocalAppCandidate({ repoRoot, appPath, sourceCommit, stagingPath })`.
- Produces: `promoteLocalAppUpdate({ transactionPath, platformAdapters })`.
- Produces: `POST /api/daemon/prepare-local-update` returning `{ transactionId, survivingWorkers }` and emitting `ensync-local-update-ready-to-stop` after response flush.

- [ ] **Step 1: Write failing rollback and same-PID continuation tests**

```js
test('promotion waits for shell and Host, excludes worker PIDs, and atomically replaces the app', async (t) => {
  const fixture = await promotionFixture(t)
  const result = await promoteLocalAppUpdate({
    transactionPath: fixture.transactionPath,
    waitForExit: fixture.waitForExit,
    inspectBundle: fixture.inspectBundle,
    renamePath: fixture.renamePath,
    launch: fixture.launch,
  })
  assert.deepEqual(fixture.waitedPids, [fixture.shellPid, fixture.hostPid])
  assert.equal(fixture.waitedPids.includes(fixture.workerPid), false)
  assert.equal(result.promoted, true)
})

test('a failed candidate verification restores the complete previous app before launch', async (t) => {
  const fixture = await promotionFixture(t, { failAfterPromotion: true })
  await assert.rejects(promoteLocalAppUpdate(fixture.options), /candidate verification failed/)
  assert.equal(await fixture.installedMarker(), 'old')
  assert.equal(fixture.launches, 1)
})

test('prepare-local-update detaches workers and does not send cancellation', async () => {
  const fixture = daemonUpdateFixture()
  const response = await fixture.prepare({ transactionId: fixture.id })
  assert.equal(response.survivingWorkers, 2)
  assert.equal(fixture.workerManager.cancelCalls, 0)
  assert.equal(fixture.workerManager.detachCalls, 1)
})
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test desktop/test/local-dev-update-helper.test.mjs desktop/test/local-dev-update.test.mjs desktop/test/host-bootstrap-lifecycle.test.mjs scripts/install-app.test.mjs`

Expected: FAIL because complete staging, promotion, and preserve-worker daemon shutdown do not exist.

- [ ] **Step 3: Refactor local installation into prepare/promote operations**

`stageLocalAppCandidate` must:

```js
await assertCleanPinnedMain(repoRoot, sourceCommit)
await run('npm', ['run', 'release:verify'], { cwd: repoRoot })
await copyInstalledAppToStaging(appPath, stagingPath)
await applyReviewedPayload({ repoRoot, stagingPath })
await writeLocalBuildInfo({ repoRoot, sourceCommit, resources: stagedResources })
await verifyLocalInstallScope({ base: appPath, candidate: stagingPath, allowedPaths: EXPECTED_LOCAL_UPDATE_PATHS })
await verifyPlatformCandidate(stagingPath)
await assertCleanPinnedMain(repoRoot, sourceCommit)
```

Write a checksum-covered transaction containing only fixed absolute paths resolved by the native process, pinned SHA/build identity, shell/Host PIDs with start times, verified worker exclusions, and phase. The helper revalidates the transaction and process identities, waits only for shell/Host exit, renames installed to backup then candidate to installed, verifies, launches with `ELECTRON_RUN_AS_NODE` and all `ENSYNC_HOST_*`/project variables removed, and deletes the backup only after the new app records health. Windows uses explicit rename retries for transient sharing violations; it never changes Store paths.

After the daemon endpoint response finishes, bootstrap calls:

```js
await server.ensyncServices.landingCoordinator.shutdown()
await server.ensyncServices.chatJobs.shutdown({ preserveWorkers: true })
await stop(0, { preserveWorkers: true })
```

The native manager spawns the helper with a verified absolute system Node executable, `detached:true`, `shell:false`, `stdio:'ignore'`, waits for a helper-ready marker, invokes the daemon endpoint, and calls `app.quit()`. It does not use `app.relaunch()`, because promotion must happen after the old executable exits.

- [ ] **Step 4: Verify GREEN**

Run: `node --test desktop/test/local-dev-update-helper.test.mjs desktop/test/local-dev-update.test.mjs desktop/test/host-bootstrap-lifecycle.test.mjs scripts/install-app.test.mjs`

Expected: all tests PASS, injected failure at every promotion boundary restores the old app, and worker PIDs are never waited on or signalled.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/local-dev-update-helper.mjs desktop/test/local-dev-update-helper.test.mjs desktop/src/local-dev-update.mjs desktop/test/local-dev-update.test.mjs desktop/src/host-bootstrap.mjs desktop/test/host-bootstrap-lifecycle.test.mjs host/server.mjs host/chat-jobs.mjs scripts/install-app.mjs scripts/install-app.test.mjs
git commit -m "feat: atomically update and restart the local app"
```

---

### Task 11: Native IPC and Settings Update-now UI

**Files:**
- Create: `src/lib/localDevelopmentUpdate.mjs`
- Create: `src/lib/localDevelopmentUpdate.d.mts`
- Create: `src/components/LocalDevelopmentUpdate.tsx`
- Create: `host/local-development-update-ui.test.mjs`
- Modify: `src/components/NativeUpdatePreferences.tsx`
- Modify: `src/App.tsx`
- Modify: `src/vite-env.d.ts`
- Modify: `src/index.css`
- Modify: `desktop/src/preload.cjs`
- Modify: `desktop/src/main.mjs`
- Modify: `desktop/test/native-ipc-order.test.mjs`
- Modify: `desktop/test/native-update-ipc.test.mjs`

**Interfaces:**
- Consumes: Task 9 native manager.
- Produces bridge methods `getLocalDevelopmentUpdateState()`, `checkLocalDevelopmentUpdate()`, `updateLocalDevelopmentNow()`, and `onLocalDevelopmentUpdateState(callback)`.

- [ ] **Step 1: Write failing bridge/UI tests**

```js
test('local Update now bridge ignores renderer arguments and authorizes the owning window', async () => {
  const calls = []
  const handler = createAuthorizedLocalUpdateHandler({
    isAuthorized: () => true,
    action: () => calls.push('update'),
  })
  await handler(trustedEvent, { sourcePath: '/tmp/evil', command: 'rm' })
  assert.deepEqual(calls, ['update'])
  assert.deepEqual(await handler(untrustedEvent), unauthorizedLocalUpdateState())
})

test('Settings renders one enabled Update now action for an available dev candidate', () => {
  const source = readFileSync('src/components/LocalDevelopmentUpdate.tsx', 'utf8')
  assert.match(source, />Update now</)
  assert.match(source, /runningWorkers/)
  assert.doesNotMatch(source, /sourcePath|executable|commandArgs/)
})
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test desktop/test/native-update-ipc.test.mjs desktop/test/native-ipc-order.test.mjs host/local-development-update-ui.test.mjs`

Expected: FAIL because the local update bridge and component are absent.

- [ ] **Step 3: Implement fixed IPC and phase-driven UI**

Add fixed channel constants only:

```js
const LOCAL_UPDATE_GET_STATE_CHANNEL = 'ensync:local-updates:get-state'
const LOCAL_UPDATE_CHECK_CHANNEL = 'ensync:local-updates:check'
const LOCAL_UPDATE_NOW_CHANNEL = 'ensync:local-updates:update-now'
const LOCAL_UPDATE_STATE_CHANNEL = 'ensync:local-updates:state'
```

Preload methods take no arguments. Main handlers call the manager directly and use the existing registered-window plus trusted-`ensync://app` authorization. Broadcast state only to owned trusted windows.

Render the card only when `state.localDevelopment === true`. Show installed/latest display versions, build/SHA abbreviations, exact phase text, worker/queued counts, and one button disabled unless `state.canUpdateNow`. During restart show “Ensync will close and reopen. Running jobs stay active in detached workers.” Retain the signed release card below it without changing channel actions.

- [ ] **Step 4: Verify GREEN, TypeScript, and build**

Run: `node --test desktop/test/native-update-ipc.test.mjs desktop/test/native-ipc-order.test.mjs host/local-development-update-ui.test.mjs && tsc --noEmit -p tsconfig.app.json && npm run build`

Expected: all tests PASS and the renderer build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/localDevelopmentUpdate.mjs src/lib/localDevelopmentUpdate.d.mts src/components/LocalDevelopmentUpdate.tsx host/local-development-update-ui.test.mjs src/components/NativeUpdatePreferences.tsx src/App.tsx src/vite-env.d.ts src/index.css desktop/src/preload.cjs desktop/src/main.mjs desktop/test/native-ipc-order.test.mjs desktop/test/native-update-ipc.test.mjs
git commit -m "feat: add local Update now control"
```

---

### Task 12: End-to-end restart continuation and durable documentation

**Files:**
- Create: `host/job-worker-restart.e2e.test.mjs`
- Modify: `.ensync/architecture.md`
- Modify: `.ensync/features/distribution.md`
- Modify: `.ensync/features/workspace-tabs.md`
- Modify: `desktop/README.md`
- Modify: `docs/release-runbook.md`
- Modify: `/Users/mikeyhasson/.claude/projects/-Users-mikeyhasson-dev-ensync/memory/ensync-architecture.md`
- Modify: `/Users/mikeyhasson/.claude/projects/-Users-mikeyhasson-dev-ensync/memory/MEMORY.md` only if its existing architecture link/description needs a concise update.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: one executable proof that the provider PID and job ID survive gateway replacement.

- [ ] **Step 1: Write the failing process-level continuation test**

Use a fixture provider that writes its PID, emits one event, waits on a user-only gate file, then emits its final structured result:

```js
test('provider process and retained job continue across Host replacement', async (t) => {
  const fixture = await restartFixture(t)
  const firstHost = await fixture.startHost()
  const job = await firstHost.startJob(fixture.request)
  const providerPid = await fixture.readProviderPid()
  await firstHost.prepareLocalUpdate(fixture.transactionId)
  await firstHost.waitForExit()

  const secondHost = await fixture.startHost()
  assert.equal((await secondHost.getJob(job.id)).state, 'running')
  assert.equal(await fixture.readProviderPid(), providerPid)
  await fixture.releaseProvider()
  const events = await secondHost.eventsAfter(job.id, 0)
  assert.equal(events.filter((event) => event.type === 'completed').length, 1)
  assert.equal(fixture.providerStartCount(), 1)
})
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test host/job-worker-restart.e2e.test.mjs`

Expected: FAIL until every real spawn/bootstrap/recovery path is connected.

- [ ] **Step 3: Connect the production spawn, recovery, and acknowledgement path exposed by the test**

Wire the test through `desktop/src/host-bootstrap.mjs`, `host/server.mjs`, `JobWorkerManager`, and the real journal classes. Do not add a test-only production branch. The expected runtime sequence is:

```text
Host A -> worker W -> provider P
Host A update-detach and exit
worker W -> provider P remains alive
Host B -> authenticate and adopt worker W
worker W -> Host B terminal handoff -> landing enqueue -> acknowledgement
```

For each failing assertion, fix the owning focused module—event replay in `job-worker-server/client`, ownership adoption in
`project-isolation`, landing import in `landing-journal/coordinator`, or acknowledgement ordering in
`chat-jobs/job-worker-manager`—and add a focused regression assertion before rerunning the E2E test.

- [ ] **Step 4: Update the canonical project decisions and operator docs**

Record these exact facts in the existing focused files:

```markdown
- Local dev Update now is explicit and separate from signed release updates.
- Provider processes live in versioned detached job workers, so replacing the Host gateway does not replay prompts.
- A new Host reattaches compatible workers before admitting jobs; incompatible workers remain alive and visible.
- The update helper promotes a fully verified candidate or restores the complete prior app.
- Public beta/stable and Microsoft Store behavior is unchanged.
```

Update the existing shared `ensync-architecture.md` memory topic rather than creating another memory file. Keep test logs and task status out of memory.

- [ ] **Step 5: Run the full fresh verification gate**

Run:

```bash
node --test host/job-worker-restart.e2e.test.mjs
npm run lint
tsc --noEmit -p tsconfig.app.json
npm run test:host
npm run test:release-compatibility
npm --prefix desktop run verify
npm --prefix site test
npm run build
git diff --check
```

Expected: every command exits 0, no tests fail, TypeScript reports no errors, and `git diff --check` prints nothing.

- [ ] **Step 6: Commit the completed integration and documentation**

```bash
git add host/job-worker-restart.e2e.test.mjs .ensync/architecture.md .ensync/features/distribution.md .ensync/features/workspace-tabs.md desktop/README.md docs/release-runbook.md
git commit -m "docs: record restart-surviving local updates"
```

- [ ] **Step 7: Install the merged clean main build without stopping the active legacy Host**

First verify the exact source:

```bash
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain=v1 --untracked-files=all)"
node scripts/install-app.mjs
codesign --verify --strict /Applications/Ensync.app
osascript -e 'tell application "Ensync" to quit'
( env -u ELECTRON_RUN_AS_NODE -u ENSYNC_HOST_ENTRY -u ENSYNC_HOST_AUTH_TOKEN -u ENSYNC_HOST_STATE_FILE -u ENSYNC_HOST_JOB_JOURNAL_FILE -u ENSYNC_HOST_PROJECT_ISOLATION_ROOT -u ENSYNC_DEFAULT_PROJECT_PATH nohup "/Applications/Ensync.app/Contents/MacOS/Ensync" >/tmp/ensync-launch.log 2>&1 & )
```

The current conversation began under the pre-worker daemon, so do not invoke the new daemon-restart action during this run. Relaunch only the Electron shell with daemon variables removed; the legacy daemon must remain alive until this job has delivered its terminal result. The next user-initiated **Update now** exercises the new worker-preserving restart path.

Do not push as part of this task. If local `main` is ahead of `origin/main`, report that fact explicitly; publishing is a
separate external mutation. Before relaunching, confirm the old shell has exited using the singleton lock PID or a bounded
poll. Never signal the Host PID during this legacy-session install.

---

## Plan self-review checklist

- Every approved spec section maps to Tasks 1–12: version identity, durable workers, protocol/authentication, Host recovery, exact landing import, staged update/rollback, daemon handoff, UI, platform parity, security, and process-level verification.
- Public release and Store behavior are explicitly excluded from the local mutation path.
- Later tasks use the exact earlier interfaces: `enqueueUnique`, `completionSink.persist`, `JobWorkerManager`, `ChatJobService.initialize`, and `shutdown({ preserveWorkers })`.
- No task asks a worker to publish a branch or asks the renderer to supply a path/command.
- The final live install does not kill the legacy daemon that owns the implementation conversation.

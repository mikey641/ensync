# Agent Work Landing & Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent work durable (auto-commit at run end), current (auto-sync at run start), visible (review-to-land UI onto the baseline branch), detected (shared-checkout change surfacing), and contained (per-provider capability records) — for every provider, per the approved spec at `docs/superpowers/specs/2026-08-09-agent-work-landing-design.md`.

**Architecture:** All new mechanisms are Ensync-Host-owned Git operations built into `ProjectIsolationService` (worktree lifecycle), `GitWorkflowService` (explicit user Git operations), and the chat run lifecycle in `host/chat.mjs`. The provider process is never consulted. The renderer gets two new routes plus an "Unlanded work" section in the existing Git modal.

**Tech Stack:** Node ESM (`.mjs`), real `git` via the existing `runGit` spawner (argument arrays, never shell), `node --test` + `node:assert/strict`, React/TypeScript renderer, existing loopback HTTP host.

## Global Constraints

- "Baseline branch" = the shared checkout's checked-out branch, discovered at operation time; never a hardcoded name.
- The shared checkout, its index, branch, and history are never mutated except by the explicit Land action, and Land refuses when the shared checkout is dirty.
- Agent commits always use identity `Ensync Agent <agent@ensync.local>` (author AND committer), never the user's identity, and always disable signing and hooks (`-c commit.gpgsign=false`, `--no-verify`).
- Land merges are never `--force`, never touch remotes, never delete branches. Land merge messages start with the exact prefix `Ensync land: ` (used for detection exclusion).
- Every failure fails closed with a specific `code` and factual message; detection facts are surfaced without attribution ("changed during this run", never "the agent changed it").
- All git invocations are argument arrays through the existing `runGit`/`#git`/`checkedGit` helpers. No shell strings.
- Tests use temporary repositories under `mkdtemp` and local bare remotes only; never a real remote. Test style: `import test from 'node:test'`, `assert from 'node:assert/strict'`, `async (context)` bodies, cleanup via `context.after(...)`. Run a single file with `node --test host/<file>.test.mjs` from the repo root.
- Code inside `remoteBridgeMain` (`host/remote-ssh-bridge.mjs`) must be self-contained: CommonJS `require('node:…')` only, no imports from the checkout, everything inside the serialized function body.
- Commit after every task with a focused message.

---

### Task 1: `commitAgentWork` on ProjectIsolationService

**Files:**
- Modify: `host/project-isolation.mjs` (add constant near line 12, method on `ProjectIsolationService`)
- Test: `host/project-isolation.test.mjs`

**Interfaces:**
- Consumes: existing `this.#git(args, options)` helper, `workspace.repositoryPath` (worktree path), `workspace.branch`.
- Produces: `async commitAgentWork(workspace, details = {})` → `{ committed: boolean, changedFiles: number, head: string }`. `details`: `{ outcome: 'succeeded'|'failed'|'timed_out'|'cancelled'|'recovered', provider?: string|null, jobId?: string|null }`. Throws `ProjectIsolationError('agent_work_commit_failed', …, 409)` on git failure. Tasks 2, 3, and 12 call this (Task 12 via the same code path).

- [ ] **Step 1: Write the failing tests**

Append to `host/project-isolation.test.mjs`:

```js
test('commitAgentWork commits worktree changes to the conversation branch with the Ensync Agent identity', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-commit')
  context.after(() => lease.release())

  await writeFile(join(lease.workspace.projectPath, 'agent-file.txt'), 'work\n')
  const result = await isolation.commitAgentWork(lease.workspace, {
    outcome: 'succeeded',
    provider: 'codex',
    jobId: 'job-1',
  })

  assert.equal(result.committed, true)
  assert.equal(result.changedFiles, 1)
  assert.match(result.head, /^[a-f0-9]{40}$/)
  const author = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%an <%ae>'])
  assert.equal(author, 'Ensync Agent <agent@ensync.local>')
  const committer = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%cn <%ce>'])
  assert.equal(committer, 'Ensync Agent <agent@ensync.local>')
  const subject = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%s'])
  assert.equal(subject, 'Ensync agent work (succeeded)')
  const body = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%b'])
  assert.match(body, /Provider: codex/)
  assert.match(body, /Job: job-1/)
  assert.equal(await git(lease.workspace.repositoryPath, ['status', '--porcelain']), '')
  // Shared checkout untouched.
  assert.equal(await git(fixture.repository, ['status', '--porcelain']), '')
})

test('commitAgentWork on a clean worktree commits nothing', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-clean')
  context.after(() => lease.release())

  const headBefore = await git(lease.workspace.repositoryPath, ['rev-parse', 'HEAD'])
  const result = await isolation.commitAgentWork(lease.workspace, { outcome: 'failed' })
  assert.equal(result.committed, false)
  assert.equal(result.changedFiles, 0)
  assert.equal(result.head, headBefore)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern='commitAgentWork' host/project-isolation.test.mjs`
Expected: FAIL — `isolation.commitAgentWork is not a function`.

- [ ] **Step 3: Implement**

In `host/project-isolation.mjs`, add near the top (after `WORKSPACE_KEY_CONTROL_CHARACTERS`, line 12):

```js
const AGENT_COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Ensync Agent',
  GIT_AUTHOR_EMAIL: 'agent@ensync.local',
  GIT_COMMITTER_NAME: 'Ensync Agent',
  GIT_COMMITTER_EMAIL: 'agent@ensync.local',
}

function agentCommitMessage(details, branch) {
  const lines = [`Ensync agent work (${details.outcome})`, '']
  if (details.provider) lines.push(`Provider: ${details.provider}`)
  if (details.jobId) lines.push(`Job: ${details.jobId}`)
  lines.push(`Workspace-Branch: ${branch}`)
  return lines.join('\n')
}
```

Add a public method to `ProjectIsolationService` (after `acquire`, before `#git`):

```js
  async commitAgentWork(workspace, details = {}) {
    const outcome = details.outcome ?? 'failed'
    return this.#commitWorktree(workspace.repositoryPath, workspace.branch, { ...details, outcome })
  }

  async #commitWorktree(worktreePath, branch, details) {
    const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: worktreePath,
      code: 'agent_work_commit_failed',
      message: `Ensync could not inspect the protected worktree for ${branch}.`,
    })
    const changedFiles = status.stdout.split('\0').filter(Boolean).length
    if (changedFiles === 0) {
      const head = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath })
      return { committed: false, changedFiles: 0, head: firstLine(head.stdout) }
    }
    const env = {
      ...AGENT_COMMIT_IDENTITY,
      GIT_AUTHOR_DATE: new Date(this.#now()).toISOString(),
      GIT_COMMITTER_DATE: new Date(this.#now()).toISOString(),
    }
    await this.#git(['add', '-A', '--', '.'], {
      cwd: worktreePath,
      env,
      code: 'agent_work_commit_failed',
      message: `Ensync could not stage this run's changes on ${branch}.`,
    })
    await this.#git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', agentCommitMessage(details, branch)], {
      cwd: worktreePath,
      env,
      code: 'agent_work_commit_failed',
      message: `Ensync could not commit this run's changes on ${branch}.`,
    })
    const head = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath })
    return { committed: true, changedFiles, head: firstLine(head.stdout) }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern='commitAgentWork' host/project-isolation.test.mjs`
Expected: PASS (2 tests). Then run the whole file to check for regressions: `node --test host/project-isolation.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add host/project-isolation.mjs host/project-isolation.test.mjs
git commit -m "Add Ensync Agent run-work commit primitive to project isolation"
```

---

### Task 2: Run-end auto-commit in the chat run lifecycle

**Files:**
- Modify: `host/chat.mjs` (outcome tracking around the lease-held `try` at lines 711–851)
- Test: `host/project-isolation.test.mjs` (the end-to-end `ChatRunService` pattern at lines 266–328 is the template)

**Interfaces:**
- Consumes: `commitAgentWork(workspace, details)` from Task 1; existing `workspaceLease`/`workspace` variables (`chat.mjs:668-683`); `options.onEvent`.
- Produces: notice events `agent_work_committed` and `agent_work_commit_failed` in the run event stream. Every run outcome (success, failure, timeout, cancel) commits while the lease is held. Task 5 adds detection to the same `finally`.

- [ ] **Step 1: Write the failing test**

Append to `host/project-isolation.test.mjs` (copy the fake-runner setup from the existing end-to-end test at lines 266–328 — fake `processRunner`, fake `#statusService` object, real isolation service):

```js
test('a chat run auto-commits agent work at run end, on success and on failure', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  for (const [key, exitCode, outcome] of [
    ['window-a:chat-autocommit-ok', 0, 'succeeded'],
    ['window-a:chat-autocommit-fail', 1, 'failed'],
  ]) {
    const events = []
    let worktreeProjectPath = null
    const chats = new ChatRunService({
      projectIsolation: isolation,
      statusService: { getProvider: async () => ({ id: 'codex', name: 'Codex', installed: true, authenticated: true, authenticationMethod: 'chatgpt', executable: '/fake/codex' }), invalidate() {} },
      processRunner: async (executable, args, options) => {
        worktreeProjectPath = options.cwd
        await writeFile(join(options.cwd, 'made-by-agent.txt'), 'partial or complete work\n')
        return {
          exitCode,
          stdout: exitCode === 0
            ? '{"type":"item.completed","item":{"item_type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{}}\n'
            : '',
          stderr: exitCode === 0 ? '' : 'provider exploded',
          aborted: false, timedOut: false, error: null,
        }
      },
    })

    const run = chats.run(
      { provider: 'codex', prompt: 'do work', projectPath: fixture.repository, workspaceKey: key },
      { onEvent: (event) => events.push(event) },
    )
    if (exitCode === 0) await run
    else await assert.rejects(run)

    const committed = events.find((event) => event.code === 'agent_work_committed')
    assert.ok(committed, `expected agent_work_committed event for exit ${exitCode}`)
    assert.match(committed.message, /made-by-agent|1 changed file/i)
    const branchLog = await git(worktreeProjectPath, ['log', '-1', '--format=%s'])
    assert.equal(branchLog, `Ensync agent work (${outcome})`)
    assert.equal(await git(worktreeProjectPath, ['status', '--porcelain']), '')
  }
})
```

Note: if the fake `statusService`/result-parsing shapes drift from the existing end-to-end test at `host/project-isolation.test.mjs:266-328`, copy that test's exact fakes — it is the source of truth for what `ChatRunService` needs.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern='auto-commits agent work' host/project-isolation.test.mjs`
Expected: FAIL — no `agent_work_committed` event exists yet.

- [ ] **Step 3: Implement in `host/chat.mjs`**

(a) Just before the `try` that opens at line 711, add outcome tracking (after the `publicWorkspace` block at lines 703–709):

```js
    let runOutcome = 'failed'
```

(b) In Path A (live-turn) success, at line 733–734, and Path B success at lines 832–833, set the outcome before returning — both places currently read:

```js
        workspaceLease?.assertHeld()
        return {
```

change each to:

```js
        workspaceLease?.assertHeld()
        runOutcome = 'succeeded'
        return {
```

(c) Insert a `catch` between the lease-held `try` body (ends line 847) and the shared `finally` (line 848):

```js
    } catch (error) {
      if (error?.code === 'run_cancelled') runOutcome = 'cancelled'
      else if (error?.code === 'run_timed_out') runOutcome = 'timed_out'
      throw error
    } finally {
```

(d) Extend the shared `finally` (currently `combinedSignal.dispose(); await workspaceLease?.release()`) to commit before releasing:

```js
    } finally {
      combinedSignal.dispose()
      if (workspace && this.#projectIsolation) {
        try {
          const workCommit = await this.#projectIsolation.commitAgentWork(workspace, {
            outcome: runOutcome,
            provider: request.provider,
            jobId: typeof options.jobId === 'string' ? options.jobId : null,
          })
          if (workCommit.committed) {
            options.onEvent?.({
              type: 'notice',
              code: 'agent_work_committed',
              message: `Saved ${workCommit.changedFiles} changed file${workCommit.changedFiles === 1 ? '' : 's'} to ${workspace.branch} (run ${runOutcome}).`,
              at: new Date().toISOString(),
            })
          }
        } catch (error) {
          options.onEvent?.({
            type: 'notice',
            code: 'agent_work_commit_failed',
            message: `Ensync could not save this run's work to ${workspace.branch}: ${error instanceof Error ? error.message : 'unknown error'}. The changes remain in the protected worktree and need review.`,
            at: new Date().toISOString(),
          })
        }
      }
      await workspaceLease?.release()
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern='auto-commits agent work' host/project-isolation.test.mjs`
Expected: PASS. Then full regression: `npm run test:host` — the existing test `'a conversation receives a stable worktree without changing the shared checkout'` writes a file via the worktree WITHOUT a chat run, so it must still pass unchanged (auto-commit only runs inside `ChatRunService.run`).

- [ ] **Step 5: Commit**

```bash
git add host/chat.mjs host/project-isolation.test.mjs
git commit -m "Auto-commit agent work to the conversation branch at every run end"
```

---

### Task 3: Recovery commit for reused dirty worktrees at run start

**Files:**
- Modify: `host/project-isolation.mjs` (`#ensureWorkspace`, lines 385–517)
- Test: `host/project-isolation.test.mjs`

**Interfaces:**
- Consumes: `#commitWorktree` from Task 1.
- Produces: a reused worktree that is dirty at acquire time gets its leftovers committed as `Ensync agent work (recovered)` before anything else. First-time seeded conversations keep today's uncommitted-seed behavior exactly. Task 4 relies on reused worktrees being clean after this step.

- [ ] **Step 1: Write the failing test**

```js
test('acquire commits crash leftovers in a reused worktree as recovered work', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  const first = await isolation.acquire(fixture.repository, 'window-a:chat-recover')
  await writeFile(join(first.workspace.projectPath, 'crash-leftover.txt'), 'left behind\n')
  await first.release()

  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-recover')
  context.after(() => resumed.release())
  assert.equal(await git(resumed.workspace.repositoryPath, ['status', '--porcelain']), '')
  const subject = await git(resumed.workspace.repositoryPath, ['log', '-1', '--format=%s'])
  assert.equal(subject, 'Ensync agent work (recovered)')
  // The recovered content is durable on the branch.
  const shown = await git(resumed.workspace.repositoryPath, ['show', 'HEAD:crash-leftover.txt'])
  assert.equal(shown, 'left behind')
})

test('a first-time seeded conversation still exposes inherited shared-checkout state as uncommitted work', async (context) => {
  const fixture = await repositoryFixture(context)
  await writeFile(join(fixture.repository, 'tracked.txt'), 'user edit\n')
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-seeded')
  context.after(() => lease.release())
  assert.equal(lease.workspace.seededFromSharedCheckout, true)
  assert.equal(lease.workspace.gitBefore.dirty, true)
  const subject = await git(lease.workspace.repositoryPath, ['log', '-1', '--format=%s'])
  assert.equal(subject, 'baseline')
})
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `node --test --test-name-pattern='recovered work|seeded conversation still exposes' host/project-isolation.test.mjs`
Expected: first test FAILS (leftovers stay uncommitted today); second PASSES already (it guards against regression).

- [ ] **Step 3: Implement**

In `#ensureWorkspace`, the `if (registered) { … } else { … }` block (lines 397–454) sets `reused`/creates the worktree. Track whether this acquire created the branch fresh, then recover leftovers only for pre-existing workspaces. In the `else` branch, after computing `branchExists` (line 415), remember it; after the whole `if/else`, before the common-directory verification at line 456, add:

```js
    const createdThisAcquire = !registered && !branchExistedBeforeAcquire
    if (!createdThisAcquire) {
      const leftovers = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath })
      if (leftovers.stdout.split('\0').filter(Boolean).length > 0) {
        await this.#commitWorktree(worktreePath, branch, { outcome: 'recovered' })
      }
    }
```

Where `branchExistedBeforeAcquire` is a `let` declared before the `if (registered)` block, set `true` inside `if (registered)`, and set to `branchExists` in the `else` branch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test host/project-isolation.test.mjs`
Expected: both new tests PASS; the existing seed test `'a conversation receives a stable worktree…'` now needs review — it releases and re-acquires with an uncommitted `agent-change.txt` and asserts `resumed.workspace.gitBefore.changedFiles === 1`. After this task that file is recovery-committed, so `gitBefore.changedFiles` becomes `0` and the file content assertion still passes. Update that single assertion to `assert.equal(resumed.workspace.gitBefore.changedFiles, 0)` and add `assert.equal(await git(resumed.workspace.repositoryPath, ['log', '-1', '--format=%s']), 'Ensync agent work (recovered)')`. This is a deliberate behavior change mandated by the spec, not a broken test to paper over.

- [ ] **Step 5: Commit**

```bash
git add host/project-isolation.mjs host/project-isolation.test.mjs
git commit -m "Recover uncommitted agent worktree leftovers at run start"
```

---

### Task 4: Run-start auto-sync from the baseline branch

**Files:**
- Modify: `host/project-isolation.mjs` (`#ensureWorkspace`, after the Task 3 recovery block)
- Test: `host/project-isolation.test.mjs`

**Interfaces:**
- Consumes: `repository.head` (baseline commit at acquire, `#repository()` line 248–258), clean reused worktree guaranteed by Task 3.
- Produces: reused worktrees whose branch lacks baseline commits get `merge <baseline>` before the provider starts; conflicts throw `ProjectIsolationError('workspace_baseline_conflict', message listing files, 409)` with the merge fully aborted. New error code consumed by renderer error display as-is (generic error path, no renderer change needed).

- [ ] **Step 1: Write the failing tests**

```js
test('acquire merges new baseline commits into a reused conversation branch', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  const first = await isolation.acquire(fixture.repository, 'window-a:chat-sync')
  await writeFile(join(first.workspace.projectPath, 'agent-work.txt'), 'agent side\n')
  await first.release()

  // Baseline advances (as if another chat landed work).
  await writeFile(join(fixture.repository, 'landed.txt'), 'landed by another chat\n')
  await git(fixture.repository, ['add', 'landed.txt'])
  await git(fixture.repository, ['commit', '-m', 'Ensync land: ensync/chat-other'])

  const resumed = await isolation.acquire(fixture.repository, 'window-a:chat-sync')
  context.after(() => resumed.release())
  const landed = await git(resumed.workspace.repositoryPath, ['show', 'HEAD:landed.txt'])
  assert.equal(landed, 'landed by another chat')
  // Recovery-committed agent work survives the merge.
  const agentSide = await git(resumed.workspace.repositoryPath, ['show', 'HEAD:agent-work.txt'])
  assert.equal(agentSide, 'agent side')
  assert.equal(await git(resumed.workspace.repositoryPath, ['status', '--porcelain']), '')
})

test('acquire fails closed with the conflicting files when baseline sync conflicts', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  const first = await isolation.acquire(fixture.repository, 'window-a:chat-conflict')
  await writeFile(join(first.workspace.projectPath, 'tracked.txt'), 'agent version\n')
  await first.release()

  await writeFile(join(fixture.repository, 'tracked.txt'), 'baseline version\n')
  await git(fixture.repository, ['add', 'tracked.txt'])
  await git(fixture.repository, ['commit', '-m', 'baseline change'])

  await assert.rejects(
    isolation.acquire(fixture.repository, 'window-a:chat-conflict'),
    (error) => error instanceof ProjectIsolationError
      && error.code === 'workspace_baseline_conflict'
      && /tracked\.txt/.test(error.message),
  )

  // The aborted merge leaves no merge in progress, so a retry fails the same
  // clean way instead of erroring on a half-merged worktree.
  await assert.rejects(
    isolation.acquire(fixture.repository, 'window-a:chat-conflict'),
    (error) => error instanceof ProjectIsolationError && error.code === 'workspace_baseline_conflict',
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern='baseline' host/project-isolation.test.mjs`
Expected: FAIL — merge does not happen yet / no `workspace_baseline_conflict` code.

- [ ] **Step 3: Implement**

In `#ensureWorkspace`, directly after the Task 3 recovery block (still before the common-directory verification at line 456), add:

```js
    if (!createdThisAcquire) {
      const upToDate = await this.#git(['merge-base', '--is-ancestor', repository.head, 'HEAD'], {
        cwd: worktreePath,
        allowFailure: true,
      })
      if (upToDate.exitCode !== 0) {
        const merge = await this.#git(
          ['-c', 'commit.gpgsign=false', 'merge', '--no-edit', '--no-verify',
            '-m', `Ensync baseline sync into ${branch}`, repository.head],
          {
            cwd: worktreePath,
            env: {
              GIT_AUTHOR_NAME: 'Ensync Agent',
              GIT_AUTHOR_EMAIL: 'agent@ensync.local',
              GIT_COMMITTER_NAME: 'Ensync Agent',
              GIT_COMMITTER_EMAIL: 'agent@ensync.local',
            },
            allowFailure: true,
          },
        )
        if (merge.exitCode !== 0) {
          const conflicted = await this.#git(['diff', '--name-only', '--diff-filter=U'], {
            cwd: worktreePath,
            allowFailure: true,
          })
          const files = conflicted.stdout.split(/\r?\n/).filter(Boolean)
          await this.#git(['merge', '--abort'], { cwd: worktreePath, allowFailure: true })
          throw new ProjectIsolationError(
            'workspace_baseline_conflict',
            `New baseline changes conflict with this conversation's work in: ${files.join(', ') || 'unknown files'}. Resolve the conflict in the protected worktree at ${worktreePath}, commit it, then run again.`,
            409,
          )
        }
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test host/project-isolation.test.mjs` (full file — the seeded-first-run tests must be untouched because `createdThisAcquire` skips both recovery and sync for fresh branches).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/project-isolation.mjs host/project-isolation.test.mjs
git commit -m "Merge baseline into reused conversation worktrees before provider start"
```

---

### Task 5: Shared-checkout change detection (local)

**Files:**
- Modify: `host/project-isolation.mjs` (extend `#ensureWorkspace` return; new `checkSharedCheckout` method), `host/chat.mjs` (finally block from Task 2)
- Test: `host/project-isolation.test.mjs`

**Interfaces:**
- Consumes: workspace object; `repository.repositoryPath` (shared checkout root).
- Produces: workspace gains `shared: { repositoryPath, head, statusEntries: string[] }` (internal; NOT added to `publicWorkspace`). New method `async checkSharedCheckout(workspace)` → `{ available: true, changed: boolean, destructive: boolean, landed: boolean, before: { head, changedFiles }, after: { head, changedFiles }, checkedAt }` or `{ available: false }` (never throws). Notice events `shared_checkout_changed` / `shared_checkout_reverted` in the run stream. Tasks 10 (containment) and 11 (SSH) reuse `workspace.shared.repositoryPath` and mirror the comparison rules.

- [ ] **Step 1: Write the failing tests**

```js
test('checkSharedCheckout reports user-style changes without attribution and reverts as destructive', async (context) => {
  const fixture = await repositoryFixture(context)
  await writeFile(join(fixture.repository, 'tracked.txt'), 'dirty before run\n')
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-detect')
  context.after(() => lease.release())

  // Unchanged.
  const same = await isolation.checkSharedCheckout(lease.workspace)
  assert.deepEqual({ available: same.available, changed: same.changed }, { available: true, changed: false })

  // Additive edit: changed, not destructive.
  await writeFile(join(fixture.repository, 'new-user-file.txt'), 'user typing during run\n')
  const edited = await isolation.checkSharedCheckout(lease.workspace)
  assert.equal(edited.changed, true)
  assert.equal(edited.destructive, false)

  // git checkout . shape: the pre-run dirty file reverts with no commit — destructive.
  await rm(join(fixture.repository, 'new-user-file.txt'))
  await git(fixture.repository, ['checkout', '--', 'tracked.txt'])
  const reverted = await isolation.checkSharedCheckout(lease.workspace)
  assert.equal(reverted.changed, true)
  assert.equal(reverted.destructive, true)
})

test('checkSharedCheckout treats an Ensync land commit as landed, not changed', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })
  const lease = await isolation.acquire(fixture.repository, 'window-a:chat-detect-land')
  context.after(() => lease.release())

  await writeFile(join(fixture.repository, 'other-chat.txt'), 'landed content\n')
  await git(fixture.repository, ['add', 'other-chat.txt'])
  await git(fixture.repository, ['commit', '-m', 'Ensync land: ensync/chat-feedbeeffeedbeeffeedbeef'])

  const result = await isolation.checkSharedCheckout(lease.workspace)
  assert.equal(result.landed, true)
  assert.equal(result.changed, false)
})
```

Add `rm` to the `node:fs/promises` import at the top of the test file if not present (it is — line 3).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern='checkSharedCheckout' host/project-isolation.test.mjs`
Expected: FAIL — `checkSharedCheckout is not a function`.

- [ ] **Step 3: Implement**

(a) In `#ensureWorkspace`, before the `return` (line 502), snapshot the shared checkout:

```js
    const sharedStatus = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repository.repositoryPath,
    })
    const shared = {
      repositoryPath: repository.repositoryPath,
      head: repository.head,
      statusEntries: sharedStatus.stdout.split('\0').filter(Boolean),
    }
```

and add `shared,` to the returned object.

Note: `repository.head` was read at `#repository()` time; the seeding path may have run since but never moves the shared `HEAD`, so it is still the correct "before" head. Re-reading here (`rev-parse --verify HEAD` with `cwd: repository.repositoryPath`) is also acceptable and more explicit — prefer the re-read.

(b) Add the public method (after `commitAgentWork`):

```js
  async checkSharedCheckout(workspace) {
    const before = workspace?.shared
    if (!before) return { available: false }
    try {
      const headResult = await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: before.repositoryPath })
      const statusResult = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: before.repositoryPath,
      })
      const afterHead = firstLine(headResult.stdout)
      const afterEntries = statusResult.stdout.split('\0').filter(Boolean)
      const headMoved = afterHead !== before.head
      const statusMoved = afterEntries.join('\n') !== before.statusEntries.join('\n')
      let landed = false
      if (headMoved) {
        const log = await this.#git(['log', '--format=%s', `${before.head}..${afterHead}`], {
          cwd: before.repositoryPath,
          allowFailure: true,
        })
        const subjects = log.exitCode === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : []
        landed = subjects.length > 0 && subjects.every((subject) => subject.startsWith('Ensync land: '))
      }
      // git checkout . shape: same head, a previously-dirty path is no longer dirty.
      const afterPaths = new Set(afterEntries.map((entry) => entry.slice(3)))
      const destructive = !headMoved
        && before.statusEntries.some((entry) => !afterPaths.has(entry.slice(3)))
      const changed = landed ? statusMoved : (headMoved || statusMoved)
      return {
        available: true,
        changed,
        destructive: changed && destructive,
        landed,
        before: { head: before.head, changedFiles: before.statusEntries.length },
        after: { head: afterHead, changedFiles: afterEntries.length },
        checkedAt: new Date(this.#now()).toISOString(),
      }
    } catch {
      return { available: false }
    }
  }
```

(c) In `host/chat.mjs`, extend the Task 2 `finally` — after the commit try/catch, before `release()`:

```js
        const sharedCheck = await this.#projectIsolation.checkSharedCheckout(workspace)
        if (sharedCheck.available && sharedCheck.changed) {
          options.onEvent?.({
            type: 'notice',
            code: sharedCheck.destructive ? 'shared_checkout_reverted' : 'shared_checkout_changed',
            message: sharedCheck.destructive
              ? `Previously modified files in the shared checkout at ${workspace.shared.repositoryPath} were reverted while this run was active, with no commit containing those changes. Ensync did not change the shared checkout. Review it before relying on its state.`
              : `The shared checkout at ${workspace.shared.repositoryPath} changed while this run was active. Ensync did not change it; you may have edited or committed concurrently.`,
            at: new Date().toISOString(),
          })
        }
```

(d) Do NOT add `shared` to `publicWorkspace` (lines 703–709) — the snapshot is Host-internal state; only the notice crosses to the renderer.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test host/project-isolation.test.mjs`, then `npm run test:host`.
Expected: PASS. The Task 2 end-to-end test must still pass (detection never throws).

- [ ] **Step 5: Commit**

```bash
git add host/project-isolation.mjs host/chat.mjs host/project-isolation.test.mjs
git commit -m "Detect and surface shared-checkout changes during agent runs"
```

---

### Task 6: Landing operations in the Git workflow service

**Files:**
- Modify: `host/git.mjs` (two new exported functions + two `GitWorkflowService` delegates)
- Test: `host/git.test.mjs`

**Interfaces:**
- Consumes: internal helpers `checkedGit` (line 133), `gitRepositoryRoot` (line 323), `GitWorkflowError`.
- Produces:
  - `async listUnlandedAgentWork(projectPath, options = {})` → `{ repositoryPath, baseline: { branch: string|null, head: string }, branches: Array<{ branch, head, aheadCount, changedFiles, lastCommittedAt, lastSubject }>, checkedAt }`
  - `async landAgentBranch(input, options = {})` with `input: { projectPath, branch }` → `{ land: { branch, mergedInto, mergeHead, completedAt }, git: GitStatus }`
  - `GitWorkflowService.unlanded(projectPath)` and `GitWorkflowService.land(input)` delegates. Task 7 wires these to HTTP; Task 8 types them.
  - Error codes: `invalid_agent_branch` (400), `git_detached_head` (409), `shared_checkout_dirty` (409), `agent_branch_already_landed` (409), `agent_branch_conflicts` (409).

- [ ] **Step 1: Write the failing tests**

Append to `host/git.test.mjs` (reuse its `git()` helper and `gitFixture`; the agent branch is created with plain git commands — no isolation service needed):

```js
async function agentBranchFixture(context) {
  const fixture = await gitFixture(context)
  if (!fixture) return null
  await git(['branch', 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa'], { cwd: fixture.seed })
  await git(['checkout', 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa'], { cwd: fixture.seed })
  await writeFile(join(fixture.seed, 'agent-feature.txt'), 'built by a chat\n')
  await git(['add', 'agent-feature.txt'], { cwd: fixture.seed })
  await git(['commit', '-m', 'Ensync agent work (succeeded)'], { cwd: fixture.seed })
  await git(['checkout', 'main'], { cwd: fixture.seed })
  return fixture
}

test('listUnlandedAgentWork reports agent branches ahead of the baseline', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  const result = await listUnlandedAgentWork(fixture.seed, { allowedRoots: [fixture.root] })
  assert.equal(result.baseline.branch, 'main')
  assert.equal(result.branches.length, 1)
  const [entry] = result.branches
  assert.equal(entry.branch, 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(entry.aheadCount, 1)
  assert.equal(entry.changedFiles, 1)
  assert.equal(entry.lastSubject, 'Ensync agent work (succeeded)')
})

test('landAgentBranch merges a clean agent branch into the baseline with a non-force merge commit', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return
  const result = await landAgentBranch(
    { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
    { allowedRoots: [fixture.root] },
  )
  assert.equal(result.land.branch, 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(result.land.mergedInto, 'main')
  const subject = (await git(['log', '-1', '--format=%s'], { cwd: fixture.seed })).stdout.trim()
  assert.equal(subject, 'Ensync land: ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa')
  const landedFile = (await git(['show', 'HEAD:agent-feature.txt'], { cwd: fixture.seed })).stdout
  assert.equal(landedFile, 'built by a chat\n')
  // Branch survives landing and is now fully merged.
  await git(['show-ref', '--verify', 'refs/heads/ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa'], { cwd: fixture.seed })
  const after = await listUnlandedAgentWork(fixture.seed, { allowedRoots: [fixture.root] })
  assert.equal(after.branches.length, 0)
})

test('landAgentBranch fails closed on dirty checkout, conflicts, and non-agent branches', async (context) => {
  const fixture = await agentBranchFixture(context)
  if (!fixture) return

  await assert.rejects(
    landAgentBranch({ projectPath: fixture.seed, branch: 'main' }, { allowedRoots: [fixture.root] }),
    (error) => error instanceof GitWorkflowError && error.code === 'invalid_agent_branch',
  )

  await writeFile(join(fixture.seed, 'README.md'), '# dirty\n')
  await assert.rejects(
    landAgentBranch(
      { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
      { allowedRoots: [fixture.root] },
    ),
    (error) => error instanceof GitWorkflowError && error.code === 'shared_checkout_dirty',
  )
  await git(['checkout', '--', 'README.md'], { cwd: fixture.seed })

  // Create a conflict: baseline edits the same file the agent branch created.
  await writeFile(join(fixture.seed, 'agent-feature.txt'), 'conflicting baseline version\n')
  await git(['add', 'agent-feature.txt'], { cwd: fixture.seed })
  await git(['commit', '-m', 'baseline conflict'], { cwd: fixture.seed })
  await assert.rejects(
    landAgentBranch(
      { projectPath: fixture.seed, branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' },
      { allowedRoots: [fixture.root] },
    ),
    (error) => error instanceof GitWorkflowError
      && error.code === 'agent_branch_conflicts'
      && /agent-feature\.txt/.test(error.message),
  )
  // No merge left in progress.
  const status = (await git(['status', '--porcelain'], { cwd: fixture.seed })).stdout.trim()
  assert.equal(status, '')
})
```

Update the import at the top of `host/git.test.mjs` to include the new exports: `listUnlandedAgentWork, landAgentBranch` (alongside the existing `GitWorkflowError, cloneGitRepository, …` import from `./git.mjs`), and `writeFile`/`join` are already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern='UnlandedAgentWork|landAgentBranch' host/git.test.mjs`
Expected: FAIL — exports do not exist.

- [ ] **Step 3: Implement in `host/git.mjs`**

Add after `pushGit` (line 456+):

```js
const AGENT_BRANCH_PATTERN = /^ensync\/chat-[a-f0-9]{24}$/
const LAND_MESSAGE_PREFIX = 'Ensync land: '

async function baselineBranch(repositoryPath, options) {
  const symbolic = await checkedGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    allowFailure: true,
  })
  return symbolic.exitCode === 0 ? symbolic.stdout.trim() : null
}

export async function listUnlandedAgentWork(projectPath, options = {}) {
  const repositoryPath = await gitRepositoryRoot(projectPath, options)
  const head = await checkedGit(['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    code: 'git_baseline_unavailable',
    failureMessage: 'The repository needs an initial commit before unlanded agent work can be listed.',
  })
  const branch = await baselineBranch(repositoryPath, options)
  const refs = await checkedGit(
    ['for-each-ref', 'refs/heads/ensync/chat-*', '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso8601-strict)%00%(contents:subject)'],
    { cwd: repositoryPath, gitExecutable: options.gitExecutable },
  )
  const branches = []
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, objectName, committedAt, subject] = line.split('\0')
    const ahead = await checkedGit(['rev-list', '--count', `HEAD..${name}`], {
      cwd: repositoryPath,
      gitExecutable: options.gitExecutable,
    })
    const aheadCount = Number.parseInt(ahead.stdout.trim(), 10) || 0
    if (aheadCount === 0) continue
    const diff = await checkedGit(['diff', '--name-only', `HEAD...${name}`], {
      cwd: repositoryPath,
      gitExecutable: options.gitExecutable,
    })
    branches.push({
      branch: name,
      head: objectName,
      aheadCount,
      changedFiles: diff.stdout.split(/\r?\n/).filter(Boolean).length,
      lastCommittedAt: committedAt || null,
      lastSubject: subject || null,
    })
  }
  return {
    repositoryPath,
    baseline: { branch, head: head.stdout.trim() },
    branches,
    checkedAt: new Date().toISOString(),
  }
}

export async function landAgentBranch(input, options = {}) {
  const branch = typeof input?.branch === 'string' ? input.branch : ''
  if (!AGENT_BRANCH_PATTERN.test(branch)) {
    throw new GitWorkflowError('Only Ensync agent conversation branches (ensync/chat-…) can be landed.', {
      code: 'invalid_agent_branch',
      status: 400,
    })
  }
  const repositoryPath = await gitRepositoryRoot(input.projectPath, options)
  await checkedGit(['show-ref', '--verify', `refs/heads/${branch}`], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    code: 'invalid_agent_branch',
    status: 400,
    failureMessage: `The agent branch ${branch} does not exist in this repository.`,
  })
  const mergedInto = await baselineBranch(repositoryPath, options)
  if (!mergedInto) {
    throw new GitWorkflowError('The shared checkout is on a detached HEAD; check out a branch before landing agent work.', {
      code: 'git_detached_head',
      status: 409,
    })
  }
  const status = await checkedGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
  })
  const dirtyCount = status.stdout.split('\0').filter(Boolean).length
  if (dirtyCount > 0) {
    throw new GitWorkflowError(
      `The shared checkout has ${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}. Commit or stash your work before landing agent changes.`,
      { code: 'shared_checkout_dirty', status: 409 },
    )
  }
  const ahead = await checkedGit(['rev-list', '--count', `HEAD..${branch}`], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
  })
  if ((Number.parseInt(ahead.stdout.trim(), 10) || 0) === 0) {
    throw new GitWorkflowError(`${branch} has no commits that are not already on ${mergedInto}.`, {
      code: 'agent_branch_already_landed',
      status: 409,
    })
  }
  const check = await checkedGit(['merge-tree', '--write-tree', '--name-only', 'HEAD', branch], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
    allowFailure: true,
  })
  if (check.exitCode !== 0 && check.exitCode !== 1) {
    throw new GitWorkflowError(
      'This Git version does not support conflict pre-checks (git 2.38+ is required for landing).',
      { code: 'git_merge_tree_unsupported', status: 409 },
    )
  }
  if (check.exitCode === 1) {
    // Conflicted output: <tree-oid>\n<conflicted files…>\n\n<informational messages>
    const rawLines = check.stdout.split(/\r?\n/)
    const blankIndex = rawLines.indexOf('', 1)
    const files = rawLines.slice(1, blankIndex === -1 ? undefined : blankIndex).filter(Boolean)
    throw new GitWorkflowError(
      `Landing ${branch} would conflict in: ${files.join(', ') || 'unknown files'}. Continue that conversation so it syncs with ${mergedInto} and resolves the conflict in its own worktree, then land.`,
      { code: 'agent_branch_conflicts', status: 409 },
    )
  }
  const merge = await checkedGit(
    ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', `${LAND_MESSAGE_PREFIX}${branch}`, branch],
    { cwd: repositoryPath, gitExecutable: options.gitExecutable, allowFailure: true },
  )
  if (merge.exitCode !== 0) {
    await checkedGit(['merge', '--abort'], { cwd: repositoryPath, gitExecutable: options.gitExecutable, allowFailure: true })
    throw new GitWorkflowError(gitFailureMessage(merge.stderr, `Git could not land ${branch}.`), {
      code: 'agent_branch_land_failed',
      status: 409,
    })
  }
  const mergeHead = await checkedGit(['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryPath,
    gitExecutable: options.gitExecutable,
  })
  return {
    land: {
      branch,
      mergedInto,
      mergeHead: mergeHead.stdout.trim(),
      completedAt: new Date().toISOString(),
    },
    git: await getGitStatus(input.projectPath, options),
  }
}
```

Add delegates to `GitWorkflowService` (after `push`, line 539):

```js
  unlanded(projectPath) {
    return listUnlandedAgentWork(projectPath, this.options())
  }

  land(input) {
    return landAgentBranch(input, this.options())
  }
```

Note: `merge-tree --write-tree` requires git ≥ 2.38 (Oct 2022); the exit-code guard above reports older Git factually instead of misreporting a conflict.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test host/git.test.mjs`
Expected: PASS (3 new + 3 existing).

- [ ] **Step 5: Commit**

```bash
git add host/git.mjs host/git.test.mjs
git commit -m "Add unlanded-work listing and guarded landing to the Git workflow service"
```

---

### Task 7: HTTP routes for unlanded work and landing

**Files:**
- Modify: `host/server.mjs` (route chain, after `/api/git/push` at line 342)
- Test: `host/server-integrations.test.mjs`

**Interfaces:**
- Consumes: `git.unlanded(projectPath)` / `git.land(input)` from Task 6; existing `readJsonBody`, `sendJson`, `GitWorkflowError` catch mapping (already handles the new codes — no change needed there).
- Produces: `POST /api/git/unlanded` `{ projectPath }` → 200 `{ unlanded: <listUnlandedAgentWork result> }`; `POST /api/git/land` `{ projectPath, branch }` → 200 `<landAgentBranch result>`. Task 8 calls these.

- [ ] **Step 1: Write the failing test**

Open `host/server-integrations.test.mjs`, find its existing host-startup/request helper (it starts `createEnsyncHost` on an ephemeral port with injected fake services), and add a test following that exact harness. The logic to express, using an injected fake `gitService`:

```js
test('git unlanded and land routes delegate to the git workflow service', async (context) => {
  const calls = []
  const fakeGit = {
    unlanded: async (projectPath) => {
      calls.push(['unlanded', projectPath])
      return { repositoryPath: projectPath, baseline: { branch: 'main', head: 'abc' }, branches: [], checkedAt: 'now' }
    },
    land: async (input) => {
      calls.push(['land', input])
      return { land: { branch: input.branch, mergedInto: 'main', mergeHead: 'def', completedAt: 'now' }, git: {} }
    },
  }
  // Start the host exactly like the neighboring tests in this file, passing
  // `gitService: fakeGit` in the createEnsyncHost options, then:
  const unlanded = await postJson('/api/git/unlanded', { projectPath: '/tmp/project' })
  assert.equal(unlanded.status, 200)
  assert.equal(unlanded.body.unlanded.baseline.branch, 'main')
  const landed = await postJson('/api/git/land', { projectPath: '/tmp/project', branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' })
  assert.equal(landed.status, 200)
  assert.equal(landed.body.land.mergedInto, 'main')
  assert.deepEqual(calls.map(([name]) => name), ['unlanded', 'land'])
})
```

`postJson` here stands for whatever request helper the file already uses (fetch against the listening port with the file's standard headers/auth) — reuse it verbatim; do not invent a parallel harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern='unlanded and land routes' host/server-integrations.test.mjs`
Expected: FAIL — 404 from the unmatched route.

- [ ] **Step 3: Implement in `host/server.mjs`**

After the `/api/git/push` route (lines 338–342), add:

```js
      if (request.method === 'POST' && url.pathname === '/api/git/unlanded') {
        const body = await readJsonBody(request)
        const unlanded = await git.unlanded(body.projectPath)
        return sendJson(response, 200, { unlanded }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/git/land') {
        const body = await readJsonBody(request)
        const result = await git.land(body)
        return sendJson(response, 200, result, origin)
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test host/server-integrations.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/server.mjs host/server-integrations.test.mjs
git commit -m "Expose unlanded-work and land routes on the Ensync Host"
```

---

### Task 8: Renderer client methods and types

**Files:**
- Modify: `src/lib/relayHost.ts` (types near `GitPushResult` at line 189; methods after `pushGit` at line 498)

**Interfaces:**
- Consumes: routes from Task 7 via the existing `request<T>` transport.
- Produces (Task 9 consumes):

```ts
export interface GitUnlandedBranch {
  branch: string
  head: string
  aheadCount: number
  changedFiles: number
  lastCommittedAt: string | null
  lastSubject: string | null
}

export interface GitUnlandedResult {
  repositoryPath: string
  baseline: { branch: string | null; head: string }
  branches: GitUnlandedBranch[]
  checkedAt: string
}

export interface GitLandResult {
  land: { branch: string; mergedInto: string; mergeHead: string; completedAt: string }
  git: GitStatus
}
```

- [ ] **Step 1: Add the types and methods**

Types go next to the existing Git types (after `GitPushResult`, line 198). Methods on `EnsyncHostClient` after `pushGit` (line 498):

```ts
  gitUnlanded(projectPath: string) {
    return this.request<{ unlanded: GitUnlandedResult }>('/git/unlanded', {
      method: 'POST',
      body: JSON.stringify({ projectPath }),
    })
  }

  landGitBranch(input: { projectPath: string; branch: string }) {
    return this.request<GitLandResult>('/git/land', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: `tsc --noEmit` passes (the vite build may take a moment; type-check success is the gate).

- [ ] **Step 3: Commit**

```bash
git add src/lib/relayHost.ts
git commit -m "Add unlanded-work and land client methods to the host client"
```

---

### Task 9: "Unlanded work" section in the Git modal

**Files:**
- Modify: `src/components/GitWorkflowModal.tsx` (manage panel, insert after the status grid at line 227), `src/components/GitWorkflowModal.css`

**Interfaces:**
- Consumes: `ensyncHost.gitUnlanded`, `ensyncHost.landGitBranch`, `GitUnlandedBranch` from Task 8; existing `busy`/`error`/`notice` state and `refreshStatus`.
- Produces: user-visible list of unlanded agent branches with per-branch **Land** buttons; conflict/dirty errors surface through the existing `setError` path.

- [ ] **Step 1: Add state and data flow**

In `GitWorkflowModal.tsx`:

- Import the type: add `GitUnlandedBranch` to the existing `import … from '../lib/relayHost'`.
- Extend the `busy` union: `'clone' | 'status' | 'connect' | 'push' | 'land' | null`.
- Add state near the others (lines 65–76): `const [unlanded, setUnlanded] = useState<GitUnlandedBranch[]>([])`.
- In `refreshStatus` (lines 86–104), after the `gitStatus` call succeeds, also load unlanded work:

```tsx
      const unlandedResponse = await ensyncHost.gitUnlanded(project.path)
      setUnlanded(unlandedResponse.unlanded.branches)
```

- Add the handler after `push` (line 171):

```tsx
  const landBranch = async (branch: string) => {
    if (!project) return
    setBusy('land')
    setError(null)
    setNotice(null)
    try {
      const result = await ensyncHost.landGitBranch({ projectPath: project.path, branch })
      setStatus(result.git)
      setNotice(`Landed ${branch} into ${result.land.mergedInto}.`)
      const refreshed = await ensyncHost.gitUnlanded(project.path)
      setUnlanded(refreshed.unlanded.branches)
    } catch (landError) {
      setError(landError instanceof Error ? landError.message : 'Landing failed.')
    } finally {
      setBusy(null)
    }
  }
```

- [ ] **Step 2: Render the section**

Inside the `mode === 'manage'` branch, after the `git-status-grid` div (line 227) and before the `git-connection-panel`:

```tsx
                  <div className="git-unlanded-panel">
                    <h3 className="git-section-heading">Unlanded agent work</h3>
                    {unlanded.length === 0 ? (
                      <p className="git-unlanded-empty">Every conversation branch is landed.</p>
                    ) : (
                      unlanded.map((entry) => (
                        <div key={entry.branch} className="git-unlanded-row">
                          <div className="git-unlanded-meta">
                            <strong>{entry.branch}</strong>
                            <small>
                              {entry.aheadCount} commit{entry.aheadCount === 1 ? '' : 's'} ahead
                              {' · '}{entry.changedFiles} file{entry.changedFiles === 1 ? '' : 's'}
                              {entry.lastSubject ? ` · ${entry.lastSubject}` : ''}
                            </small>
                          </div>
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void landBranch(entry.branch)}
                          >
                            {busy === 'land' ? 'Landing…' : 'Land'}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
```

Add matching styles to `GitWorkflowModal.css` following its existing panel classes (`.git-unlanded-panel` mirroring `.git-connection-panel` spacing; `.git-unlanded-row` as a flex row with space-between; `.git-unlanded-meta small` muted).

- [ ] **Step 3: Verify**

Run: `npm run build` (type-check + build) and `npm run lint`.
Expected: both pass. Manual check happens at the end of the plan with the full stack.

- [ ] **Step 4: Commit**

```bash
git add src/components/GitWorkflowModal.tsx src/components/GitWorkflowModal.css
git commit -m "Show unlanded agent branches with a guarded Land action in the Git modal"
```

---

### Task 10: Provider containment records and pinned arguments

**Files:**
- Modify: `host/chat.mjs` (`SUPPORTED_CHAT_PROVIDERS` area line 8, `codexArguments` line 577, `claudeArguments` line 588, `argumentsFor` line 596, call sites lines 758/767)
- Test: `host/chat.test.mjs`

**Interfaces:**
- Consumes: `workspace.shared.repositoryPath` (Task 5) as the canonical checkout to deny; `workspace.repositoryPath` as the writable worktree root.
- Produces: `CHAT_PROVIDER_CONTAINMENT` record; runs refuse providers without a record (`provider_containment_unrecorded`, 409, `safeToRetry: false`); Codex gets pinned sandbox arguments; Claude gets pinned per-run deny settings. `argumentsFor(request, attachmentPaths, containment)` where `containment` is `{ worktreePath, canonicalRepositoryPath } | null`.

- [ ] **Step 0: MANDATORY first-party verification (spec requirement — do not skip, do not guess)**

Run on this machine and read the output:

```bash
codex exec --help 2>&1 | grep -iA2 sandbox
codex --help 2>&1 | grep -iA2 sandbox
claude --help 2>&1 | grep -iA2 'settings\|permission'
```

- Confirm Codex `exec` accepts `--sandbox workspace-write` (or `-s workspace-write`) and confirm the config override syntax for extra writable roots (expected: `-c 'sandbox_workspace_write.writable_roots=["<path>"]'`) against the installed CLI's help/docs.
- Confirm Claude Code accepts `--settings <json>` with a `permissions.deny` list, and that deny rules take path patterns like `Write(/abs/path/**)`.
- **If either flag is absent or different in the installed version: STOP that provider's pinning, keep its containment record with a factual `pinned: false` and reason, and note the discrepancy in the task commit message.** The record-and-refuse logic below ships regardless; only the pinned arguments are conditional on this verification.

- [ ] **Step 1: Write the failing tests**

Append to `host/chat.test.mjs`, following its existing style for exercising `codexArguments`/`claudeArguments` (if the file tests them indirectly via run, follow that pattern; the assertions to express):

```js
test('codex arguments pin the OS sandbox to the protected worktree', () => {
  const containment = { worktreePath: '/tmp/worktree', canonicalRepositoryPath: '/tmp/shared' }
  const args = argumentsFor(
    { provider: 'codex', prompt: 'p', projectPath: '/tmp/shared' },
    [],
    containment,
  )
  assert.ok(args.includes('--sandbox'), 'expected --sandbox flag')
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write')
  const configIndex = args.findIndex((value) => typeof value === 'string' && value.includes('writable_roots'))
  assert.ok(configIndex > 0, 'expected writable_roots override')
  assert.match(args[configIndex], /\/tmp\/worktree/)
})

test('claude arguments pin deny rules for the canonical checkout', () => {
  const containment = { worktreePath: '/tmp/worktree', canonicalRepositoryPath: '/tmp/shared' }
  const args = argumentsFor(
    { provider: 'claude', prompt: 'p', projectPath: '/tmp/shared' },
    [],
    containment,
  )
  const settingsIndex = args.indexOf('--settings')
  assert.ok(settingsIndex > 0, 'expected --settings flag')
  const settings = JSON.parse(args[settingsIndex + 1])
  assert.deepEqual(settings.permissions.deny, [
    'Write(/tmp/shared/**)',
    'Edit(/tmp/shared/**)',
  ])
})

test('arguments carry no containment flags without a protected workspace', () => {
  for (const provider of ['codex', 'claude']) {
    const args = argumentsFor({ provider, prompt: 'p', projectPath: '/tmp/shared' }, [], null)
    assert.equal(args.includes('--sandbox'), false)
    assert.equal(args.includes('--settings'), false)
  }
})
```

`argumentsFor` is module-internal today — export it (it is a pure function; exporting for tests matches how `chat.test.mjs` reaches other internals; if the file instead re-derives arguments through a fake runner capture, follow that existing pattern and assert on the captured argv).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern='containment|pin the OS sandbox|deny rules' host/chat.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement in `host/chat.mjs`**

(a) Below `SUPPORTED_CHAT_PROVIDERS` (line 8):

```js
// Verified containment levels per the catalog capability contract. A provider
// with no record here is refused as runnable regardless of SUPPORTED_CHAT_PROVIDERS.
const CHAT_PROVIDER_CONTAINMENT = {
  codex: { level: 'os_sandbox' },
  claude: { level: 'permission_config' },
}
```

(b) In `ChatRunService.run`, immediately after the existing provider-support validation, add:

```js
    if (!CHAT_PROVIDER_CONTAINMENT[request.provider]) {
      throw new ChatRunError(
        'provider_containment_unrecorded',
        `${request.provider} has no verified workspace-containment record and cannot run.`,
        409,
        false,
      )
    }
```

(c) Extend the argument builders (exact flags per Step 0 verification):

```js
function codexContainmentArguments(containment) {
  if (!containment) return []
  return [
    '--sandbox', 'workspace-write',
    '-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(containment.worktreePath)}]`,
  ]
}

function claudeContainmentArguments(containment) {
  if (!containment) return []
  const settings = {
    permissions: {
      deny: [
        `Write(${containment.canonicalRepositoryPath}/**)`,
        `Edit(${containment.canonicalRepositoryPath}/**)`,
      ],
    },
  }
  return ['--settings', JSON.stringify(settings)]
}
```

Thread `containment` through: `codexArguments(request, attachmentPaths, containment)` spreads `...codexContainmentArguments(containment)` into BOTH the `exec resume` and `exec` arrays (before `--json`); `claudeArguments(request, containment)` pushes the settings args; `argumentsFor(request, attachmentPaths, containment)` passes through. At the call sites (lines 758 and 767), build:

```js
    const containment = workspace ? {
      worktreePath: workspace.repositoryPath,
      canonicalRepositoryPath: workspace.shared.repositoryPath,
    } : null
```

and pass it to both `argumentsFor` and `visibleArguments` (the displayed command must show the real pinned flags).

(d) The Codex live-turn path (`options.liveTurnId`, line 712) does not go through `codexArguments` — the app-server session is configured in `host/codex-live-turn.mjs`. Add a comment at that call site: `// Live-turn containment is pinned in codex-live-turn session configuration; verify separately before enabling sandbox there.` Then check `codex-live-turn.mjs` for a session/turn `sandbox` option in the app-server protocol; if present and documented, pin `workspace-write` there too; if not verifiable, leave a factual comment and record it in the commit message. Do not guess protocol fields.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test host/chat.test.mjs` then `npm run test:host` (the Task 2 end-to-end test now sees extra argv entries — it asserts on cwd/prompt/events, not argv, so it should pass; fix assertions only if they asserted exact argv).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/chat.mjs host/chat.test.mjs
git commit -m "Record provider containment levels and pin sandbox/permission arguments"
```

---

### Task 11: Shared-checkout detection over SSH

**Files:**
- Modify: `host/remote-ssh-bridge.mjs` (`prepareRemoteWorkspace` lines 656–674, `runChat` lines 880–920), `host/remote-ssh.mjs` (bridge-result validation lines 516–525 and the event/progress surface)
- Test: `host/remote-ssh.test.mjs`

**Interfaces:**
- Consumes: the bridge's existing `runGit(git.executable, cwd, args, { environment })` helper and envelope shape.
- Produces: bridge result gains optional top-level `sharedCheckout: { changed: boolean, destructive: boolean, landed: boolean, before: { head, changedFiles }, after: { head, changedFiles } }`; the host emits the same `shared_checkout_changed` / `shared_checkout_reverted` notices as Task 5. Absent field = older bridge = no notice (backward compatible).

- [ ] **Step 1: Write the failing test**

Extend the real-bridge-execution test pattern at `host/remote-ssh.test.mjs:372-451` (temp repo + fake provider CLI + `createRemoteBridgeInput` piped to `node -`): after building the fixture, make the canonical checkout change during the "run" by making the fake provider CLI script itself append a file to the canonical repository path (the fake CLI runs mid-bridge, exactly like a rogue remote process), then decode the envelope and assert:

```js
  assert.equal(decoded.result.sharedCheckout.changed, true)
  assert.equal(decoded.result.sharedCheckout.destructive, false)
```

And a second scenario in the same test (or a sibling test) where the fake CLI touches nothing: `assert.equal(decoded.result.sharedCheckout.changed, false)`.

Host-side notice: in the fake-ssh `processRunner` pattern (`remote-ssh.test.mjs:185-194`), return an envelope whose `result` includes `sharedCheckout: { changed: true, destructive: true, landed: false, before: { head: 'a', changedFiles: 1 }, after: { head: 'a', changedFiles: 0 } }` and assert the service's event callback received a notice with code `shared_checkout_reverted` (wire through whatever `onEvent`/progress mechanism the surrounding tests use for notices).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern='sharedCheckout|shared_checkout' host/remote-ssh.test.mjs`
Expected: FAIL — no `sharedCheckout` in the envelope.

- [ ] **Step 3: Implement**

(a) In `prepareRemoteWorkspace` (bridge), before returning, snapshot the canonical repository (the function already discovered `git.executable` and validated `projectPath`; resolve the repository root with `rev-parse --show-toplevel` on `projectPath`):

```js
      const sharedRoot = firstLine((await runGit(git.executable, projectPath, ['rev-parse', '--show-toplevel'], { environment })).stdout)
      const sharedHead = firstLine((await runGit(git.executable, sharedRoot, ['rev-parse', '--verify', 'HEAD'], { environment })).stdout)
      const sharedStatus = await runGit(git.executable, sharedRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { environment })
      const sharedEntries = sharedStatus.stdout.split('\0').filter(Boolean)
```

Return them: `{ lease, workspace, git, shared: { root: sharedRoot, head: sharedHead, statusEntries: sharedEntries } }` (note: `git` must now be part of the return so `runChat` can reuse the executable).

(b) In `runChat`, after the `runCaptured` try/finally and before the `return`, compute the after-snapshot with the same three commands and the same comparison rules as Task 5 (head moved, status moved, `Ensync land: ` exclusion via `log --format=%s before..after`, destructive = same head + previously-dirty path no longer dirty). All inline, CommonJS-safe, wrapped in try/catch so a git failure yields `sharedCheckout: null` rather than a failed run. Attach `sharedCheckout` to the returned object.

(c) In `host/remote-ssh.mjs`, the validation gate at lines 516–525 stays as-is (new field is optional). Where the service turns the decoded result into events/results, add: if `result.sharedCheckout?.changed`, emit the notice with the Task 5 codes and the same unattributed wording, substituting the remote repository root in the message.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test host/remote-ssh.test.mjs` (win32 skips the real-bridge test, matching the existing pattern).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/remote-ssh-bridge.mjs host/remote-ssh.mjs host/remote-ssh.test.mjs
git commit -m "Detect remote shared-checkout changes through the SSH bridge"
```

---

### Task 12: One-time recovery of stranded worktrees at Host startup

**Files:**
- Modify: `host/project-isolation.mjs` (new public method), `host/server.mjs` (`startEnsyncHost` listen callback, lines 777–787)
- Test: `host/project-isolation.test.mjs`

**Interfaces:**
- Consumes: `#commitWorktree` (Task 1), `this.#rootPath` layout `<root>/<repositoryHash>/<workspaceHash>`.
- Produces: `async recoverStrandedWorktrees()` → `{ scanned: number, recovered: Array<{ worktreePath, branch, changedFiles, head }>, skipped: Array<{ worktreePath, reason }> }`. Never throws; per-worktree failures are `skipped` entries. Wired fire-and-forget at Host startup.

- [ ] **Step 1: Write the failing test**

```js
test('recoverStrandedWorktrees commits dirty stranded worktrees and skips active leases', async (context) => {
  const fixture = await repositoryFixture(context)
  const isolation = new ProjectIsolationService({ rootPath: fixture.workspaceRoot })

  const stranded = await isolation.acquire(fixture.repository, 'window-a:chat-stranded')
  await writeFile(join(stranded.workspace.projectPath, 'stranded.txt'), 'never committed\n')
  const strandedPath = stranded.workspace.repositoryPath
  await stranded.release()

  const active = await isolation.acquire(fixture.repository, 'window-a:chat-active')
  context.after(() => active.release())
  await writeFile(join(active.workspace.projectPath, 'active.txt'), 'in flight\n')

  const summary = await isolation.recoverStrandedWorktrees()
  assert.equal(summary.recovered.length, 1)
  assert.equal(summary.recovered[0].worktreePath, strandedPath)
  assert.equal(summary.recovered[0].changedFiles, 1)
  assert.ok(summary.skipped.some((entry) => entry.reason === 'active_lease'))
  const subject = await git(strandedPath, ['log', '-1', '--format=%s'])
  assert.equal(subject, 'Ensync agent work (recovered)')
  // The active worktree was not touched.
  assert.match(await git(active.workspace.repositoryPath, ['status', '--porcelain']), /active\.txt/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern='recoverStrandedWorktrees' host/project-isolation.test.mjs`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement**

Add to `ProjectIsolationService` (uses `readdir` — add it to the `node:fs/promises` import at line 2):

```js
  async recoverStrandedWorktrees() {
    const summary = { scanned: 0, recovered: [], skipped: [] }
    let repositoryHashes = []
    try {
      repositoryHashes = await readdir(this.#rootPath)
    } catch {
      return summary
    }
    for (const repositoryHash of repositoryHashes) {
      let workspaceHashes = []
      try {
        workspaceHashes = await readdir(join(this.#rootPath, repositoryHash))
      } catch {
        continue
      }
      for (const workspaceHash of workspaceHashes) {
        const worktreePath = join(this.#rootPath, repositoryHash, workspaceHash)
        summary.scanned += 1
        try {
          const branchResult = await this.#git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
            cwd: worktreePath,
            allowFailure: true,
          })
          const branch = firstLine(branchResult.stdout)
          if (branchResult.exitCode !== 0 || !branch.startsWith('ensync/chat-')) {
            summary.skipped.push({ worktreePath, reason: 'not_an_agent_worktree' })
            continue
          }
          const commonResult = await this.#git(['rev-parse', '--git-common-dir'], { cwd: worktreePath })
          const commonValue = firstLine(commonResult.stdout)
          const commonDirectory = isAbsolute(commonValue) ? commonValue : resolve(worktreePath, commonValue)
          const lockPath = join(commonDirectory, 'ensync', 'workspace-write-locks', `${workspaceHash}.lock`)
          let leaseHeld = false
          try {
            await stat(lockPath)
            leaseHeld = true
          } catch { /* no active lease */ }
          if (leaseHeld) {
            summary.skipped.push({ worktreePath, reason: 'active_lease' })
            continue
          }
          const result = await this.#commitWorktree(worktreePath, branch, { outcome: 'recovered' })
          if (result.committed) {
            summary.recovered.push({ worktreePath, branch, changedFiles: result.changedFiles, head: result.head })
          } else {
            summary.skipped.push({ worktreePath, reason: 'clean' })
          }
        } catch (error) {
          summary.skipped.push({ worktreePath, reason: error instanceof Error ? error.message : 'unknown_error' })
        }
      }
    }
    return summary
  }
```

Wire into `startEnsyncHost` (`host/server.mjs:777-787`), inside the listen callback after the log line:

```js
    const isolation = server.ensyncServices?.projectIsolation
    isolation?.recoverStrandedWorktrees?.().then((summary) => {
      if (summary.recovered.length > 0) {
        console.log(`Ensync recovered uncommitted agent work in ${summary.recovered.length} worktree(s).`)
      }
    }).catch((error) => {
      console.error('Ensync stranded-work recovery failed:', error instanceof Error ? error.message : error)
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test host/project-isolation.test.mjs`, then `npm run test:host`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/project-isolation.mjs host/server.mjs host/project-isolation.test.mjs
git commit -m "Recover stranded agent worktree work at Host startup"
```

---

### Task 13: Documentation updates in `.relay`

**Files:**
- Modify: `.relay/features/git-workflows.md`, `.relay/architecture.md`, `.relay/features/agent-routing.md`

**Interfaces:** none (docs). The spec's "Documentation updates" section is the requirement list.

- [ ] **Step 1: Update `.relay/features/git-workflows.md`**

In the "Agent workspaces" section: the paragraph stating inherited state "remain[s] uncommitted inside the protected workspace" and "Ensync never cleans, stashes, commits into user history" must be revised to state the new lifecycle factually:

- Every run end commits the worktree's tracked and non-ignored untracked changes to the conversation branch as `Ensync Agent <agent@ensync.local>` with the run outcome in the message; failed, cancelled, and timed-out runs commit too.
- A reused worktree that is dirty at run start is committed first as recovered work; first-time seeded conversations still expose inherited shared-checkout state as uncommitted work until their first run ends.
- Before the provider starts, reused conversation branches merge the baseline branch; conflicts fail closed before provider start with the conflicting files listed.
- A new "Landing" subsection: Land is an explicit per-branch user action, requires a clean shared checkout and a conflict-free plumbing pre-check, produces a non-force `Ensync land: <branch>` merge commit on the baseline branch, never touches remotes, and never deletes the conversation branch. "Ensync never commits into user history" becomes "Ensync commits into user history only through the explicit Land action."

- [ ] **Step 2: Update `.relay/architecture.md`**

Boundary item 9 and the following paragraph: append the run-end auto-commit, run-start baseline sync, shared-checkout change detection (unattributed, Land-excluded, destructive-shape escalation), and startup stranded-work recovery. The sentence "Managed worktrees and branches survive run completion and failure so the user can verify and reconcile them before any future explicit cleanup workflow" gains "; their work is committed to the conversation branch at every run end and lands on the baseline branch only through the explicit review-to-land flow."

- [ ] **Step 3: Update `.relay/features/agent-routing.md`**

The capability-contract sentence (line 12: "discovery, account authentication, subscription versus paid usage, structured execution, session continuation, tool/mutation evidence, cancellation, quota, updates, local/SSH topology, and macOS/Windows support") gains "workspace containment" in the list. Add a short paragraph after the workspace-key paragraph (line 26): every runnable provider records a verified containment level (`os_sandbox`, `permission_config`, or `prompt_only`); a provider without a record is refused as runnable; Codex pins its OS sandbox in workspace-write mode scoped to the protected worktree; Claude Code pins per-run permission settings denying mutation of the canonical checkout, with its headless-shell gap stated; prompt confinement is advisory and is never presented as enforcement.

- [ ] **Step 4: Commit**

```bash
git add .relay/features/git-workflows.md .relay/architecture.md .relay/features/agent-routing.md
git commit -m "Document landing, sync, detection, and containment in .relay"
```

---

### Final verification

- [ ] Run the full gate: `npm run lint && npm run test:host && npm run build`
- [ ] Manual smoke (optional but recommended): `npm run dev`, open a chat in a Git project, run a trivial prompt, then open Git → Manage and confirm the conversation branch appears under "Unlanded agent work" and lands cleanly.
- [ ] Confirm the stranded-worktree recovery log line appears on first Host start against the real `~/.ensync/agent-workspaces-v1` (≈43 worktrees expected to be recovered or skipped-as-clean).

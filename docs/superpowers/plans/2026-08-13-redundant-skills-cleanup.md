# Redundant Skills Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove stale repository skills and decouple Ensync's embedded agent-coordination safety contract from upstream Superpowers branding or plugin metadata.

**Architecture:** Keep the existing prompt injection and runner enforcement path, including its stable marker, while renaming only the internal policy sentinel, serialized capability literal, and user/developer-facing wording. Remove the unreferenced third-party logo skill separately; retain Auto Context and historical design documents.

**Tech Stack:** Node.js ESM, Node test runner, TypeScript, React/Vite, Markdown feature memory.

## Global Constraints

- Work only in the current protected Ensync conversation worktree; do not create, switch, merge, delete, or clean worktrees or branches.
- Do not commit or push; Ensync Host owns branch landing.
- Preserve `[ENSYNC SAFE MULTI-AGENT v1]` exactly.
- Preserve the embedded coordination behavior for every supported local and SSH runner.
- Preserve subscription-only routing, safe pre-mutation fallback, and equal macOS/Windows support.
- Keep `skills/ensync-auto-context/SKILL.md` and `skills/ensync-auto-context/agents/openai.yaml`.
- Keep `brand/` outputs and `docs/superpowers/` history.

---

### Task 1: Debrand the embedded agent-coordination contract

**Files:**
- Modify: `host/multi-agent-prompt.test.mjs`
- Modify: `host/provider-runner-contract.test.mjs`
- Modify: `host/chat.test.mjs`
- Modify: `host/remote-ssh.test.mjs`
- Modify: `host/multi-agent-prompt.mjs`
- Modify: `host/multi-agent-prompt.d.mts`
- Modify: `host/provider-runner-contract.mjs`
- Modify: `host/providers.mjs`
- Modify: `host/chat.mjs`
- Modify: `src/types.ts`
- Modify: `src/data.ts`
- Modify: `src/lib/relayHost.ts`
- Modify: `.relay/features/agent-routing.md`
- Modify: `docs/providers/ollama.md`

**Interfaces:**
- Consumes: `withEnsyncMultiAgentInstructions(prompt: unknown): string` and the stable `ENSYNC_MULTI_AGENT_MARKER`.
- Produces: `ENSYNC_AGENT_COORDINATION_POLICY` with literal value `ensync_agent_coordination_v1`; `agentCoordination` objects shaped as `{ policy: 'ensync_agent_coordination_v1', delivery: 'ensync_prompt' }`.

- [ ] **Step 1: Change behavioral tests first**

  Update prompt assertions to require `This bundled Ensync agent-coordination contract applies to every Ensync provider runner` and preserve assertions for the marker, independent-work-stream decision, non-overlapping scopes, single-agent fallback, writable-project boundary, and user prompt. Rename the runner test to `every enabled provider runner is catalog-supported and bound to Ensync agent coordination locally`, import `ENSYNC_AGENT_COORDINATION_POLICY`, and compare catalog policies to that export. Update local-chat and SSH prompt-delivery expectations to the Ensync wording.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run:

  ```bash
  node --test host/multi-agent-prompt.test.mjs host/provider-runner-contract.test.mjs host/chat.test.mjs host/remote-ssh.test.mjs
  ```

  Expected: failures caused by the old Superpowers wording/export/policy literal, while unrelated assertions continue to execute.

- [ ] **Step 3: Apply the minimal production rename**

  In `host/multi-agent-prompt.mjs`, export:

  ```js
  export const ENSYNC_AGENT_COORDINATION_POLICY = 'ensync_agent_coordination_v1'
  ```

  Keep `ENSYNC_MULTI_AGENT_MARKER` unchanged. Replace the opening sentence with the tested Ensync contract wording. Replace the upstream-skill instruction with runtime-neutral guidance: `Use the runtime's applicable parallel-agent or subagent-development workflow when available. Otherwise follow this bundled contract with the runtime's native collaboration tools.`

  Update the declaration file, runner contract, provider catalog, and error text to the new constant and terminology. Remove `nativePlugin` from Host and renderer coordination types/defaults. Update only the related comment and documentation wording; do not alter routing or execution behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run:

  ```bash
  node --test host/multi-agent-prompt.test.mjs host/provider-runner-contract.test.mjs host/chat.test.mjs host/remote-ssh.test.mjs host/auto-context-fallback.test.mjs
  ```

  Expected: all active tests pass; the documented SSH catalog-parity test remains skipped.

- [ ] **Step 5: Check the deprecated coupling is gone from active product surfaces**

  Run:

  ```bash
  rg -n 'ENSYNC_SUPERPOWERS_POLICY|ensync_superpowers_v1|nativePlugin|bundled Superpowers contract|multi-agent/Superpowers' host src .relay docs/providers
  ```

  Expected: no matches. Parser-fixture prose and historical files under `docs/superpowers/` are outside this active-product check.

### Task 2: Remove the stale logo skill artifacts

**Files:**
- Delete: `.agents/skills/logo-generator/`
- Delete: `skills-lock.json`
- Preserve: `skills/ensync-auto-context/`
- Preserve: `brand/`

**Interfaces:**
- Consumes: the audited repository inventory and packaging configuration.
- Produces: a repository containing only the intentional Auto Context skill source.

- [ ] **Step 1: Delete only the audited redundant artifacts**

  Remove all tracked files under `.agents/skills/logo-generator/` and remove `skills-lock.json`. Do not remove generated brand outputs.

- [ ] **Step 2: Verify the repository skill inventory**

  Run:

  ```bash
  test ! -e .agents/skills/logo-generator
  test ! -e skills-lock.json
  test -f skills/ensync-auto-context/SKILL.md
  test -f skills/ensync-auto-context/agents/openai.yaml
  test -d brand
  test -z "$(git grep -n -E '(logo-generator|skills-lock\\.json)' -- ':!docs/superpowers/**' || true)"
  ```

  Expected: every command exits successfully.

### Task 3: Whole-task verification

**Files:**
- Verify: all changed and deleted files from Tasks 1–2.

**Interfaces:**
- Consumes: the complete working-tree diff.
- Produces: verified evidence that cleanup preserves runtime behavior and build health.

- [ ] **Step 1: Run formatting and static checks**

  ```bash
  git diff --check
  npm run lint
  npx tsc --noEmit -p tsconfig.app.json
  ```

- [ ] **Step 2: Run complete Host and desktop suites**

  ```bash
  npm run test:host
  npm --prefix desktop test
  ```

- [ ] **Step 3: Review final scope**

  ```bash
  git status --short
  git diff --stat
  git diff --name-status
  ```

  Confirm that changes are limited to the approved debranding, durable documentation, plan/spec records, and removal of the stale logo skill plus its lockfile.


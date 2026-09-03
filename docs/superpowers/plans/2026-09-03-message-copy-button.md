# Message Copy Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every stored user and agent message an accessible ChatGPT-style button that copies its original Markdown source.

**Architecture:** Extend the existing renderer-only `CopyTextButton` path instead of adding a host or native clipboard API. The stored user-message branch will render the same action row as the agent branch, while adjacent CSS will expose actions on hover, keyboard focus, and non-hover input devices.

**Tech Stack:** React, TypeScript, Vite CSS, Node.js built-in test runner

## Global Constraints

- Both stored user and agent messages receive the copy action.
- Copy `message.content` exactly; never derive clipboard text from rendered Markdown or bidi markup.
- Keep pending question-message copying intact and exclude live provider notes.
- Preserve the existing accessible label, visible success/error state, and live announcement.
- Use CSS input capabilities, not platform detection, to keep the action reachable on touch devices.
- Preserve light/dark semantic theme behavior and equal macOS/Windows support.
- Work only in the protected current worktree; do not create another worktree, push, or commit manually because Ensync Host owns saving and landing.

---

### Task 1: Copy actions for every stored conversation message

**Files:**
- Create: `host/message-copy-action.test.mjs`
- Modify: `src/App.tsx:4834-4843`
- Modify: `src/index.css:246-249`
- Modify: `src/theme.css:2036-2062`
- Modify: `.relay/features/message-rendering.md`

**Interfaces:**
- Consumes: `CopyTextButton({ text: string, label?: string, showLabel?: boolean })` and each stored message's exact `message.content: string`.
- Produces: one `.message-actions` row with `<CopyTextButton text={message.content} label="Copy message" />` in each stored user and agent branch; CSS visibility contracts for hover, `:focus-within`, and no-hover/coarse-pointer input; user-message action placement beneath rather than inside the bubble flow.

- [x] **Step 1: Write the failing renderer contract tests**

Create `host/message-copy-action.test.mjs` with:

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const appCssPath = new URL('../src/index.css', import.meta.url)

test('stored user and agent messages copy their original Markdown source', async () => {
  const app = await readFile(appPath, 'utf8')
  const storedMessageActions = app.match(
    /<CopyTextButton text=\{message\.content\} label="Copy message" \/>/g,
  ) ?? []

  assert.equal(storedMessageActions.length, 2)
  assert.match(app, /navigator\.clipboard\.writeText\(text\)/)
  assert.match(app, /aria-label=\{status === 'idle' \? label : statusLabel\}/)
  assert.match(app, /className="copy-announcement" role="status" aria-live="polite"/)
})

test('message copy actions are visible for hover, keyboard, and touch input', async () => {
  const css = await readFile(appCssPath, 'utf8')

  assert.match(
    css,
    /\.message:hover \.message-actions,\s*\.message:focus-within \.message-actions\s*\{\s*opacity:\s*1;/,
  )
  assert.match(
    css,
    /@media \(hover: none\), \(pointer: coarse\)\s*\{\s*\.message-actions\s*\{\s*opacity:\s*1;/,
  )
})
```

- [x] **Step 2: Run the focused test and verify the intended failure**

Run:

```bash
node --test host/message-copy-action.test.mjs
```

Expected: both tests fail. The first finds only the existing agent action instead of two stored-message actions; the second cannot find focus or touch visibility rules.

- [x] **Step 3: Add the user-message action and accessible visibility rules**

In the `message.role === 'user'` branch of `src/App.tsx`, append the existing shared action after attachments and before closing `.message__body`:

```tsx
<div className="message-actions">
  <CopyTextButton text={message.content} label="Copy message" />
</div>
```

Keep the existing agent and pending-question actions unchanged. Replace the single hover selector next to `.message-actions` in `src/index.css` and add the touch rule:

```css
.message:hover .message-actions,
.message:focus-within .message-actions { opacity: 1; }

@media (hover: none), (pointer: coarse) {
  .message-actions { opacity: 1; }
}
```

- [x] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node --test host/message-copy-action.test.mjs
```

Expected: 2 tests pass and 0 fail.

- [x] **Step 4a: Add a failing regression test for user-bubble layout**

Extend the test file with `themeCssPath` and a third test requiring the user action to
sit beneath the bubble without contributing empty space to the bubble's normal flow.

Expected: 2 tests pass and the new layout test fails because the action is still in
normal flow.

- [x] **Step 4b: Position the user action in the existing message gap**

In `src/theme.css`, make `.message--user` positioned and place its action beneath the
bubble using logical inset properties:

```css
.message--user {
  position: relative;
}

.message--user .message-actions {
  position: absolute;
  inset-inline-end: 0;
  inset-block-end: -29px;
  margin-top: 0;
}
```

Run the focused test again. Expected: 3 tests pass and 0 fail.

- [x] **Step 5: Record the durable message-rendering behavior**

Extend the existing copy-action sentence in `.relay/features/message-rendering.md` to state that every stored user and agent message exposes the shared action, that it copies original Markdown, and that hover, focus, and touch input can reveal or reach it. Keep temporary provider notes explicitly outside the contract.

- [x] **Step 6: Run complete verification**

Run:

```bash
npm run test:host
npm run lint
npm run build
git diff --check
git status --short --branch
```

Expected: every command exits 0; the status lists only the focused implementation, test, plan, and `.relay` documentation changes since the saved design commit.

- [x] **Step 7: Review the final diff and hand it to Ensync Host**

Run:

```bash
git diff --stat
git diff -- src/App.tsx src/index.css src/theme.css host/message-copy-action.test.mjs .relay/features/message-rendering.md docs/superpowers/plans/2026-09-03-message-copy-button.md
sed -n '1,240p' host/message-copy-action.test.mjs
sed -n '1,280p' docs/superpowers/plans/2026-09-03-message-copy-button.md
```

Confirm that no provider, persistence, host runtime, native clipboard, or unrelated UI code changed. Do not run `git commit` or `git push`; the protected Ensync Host workflow saves and lands the branch.

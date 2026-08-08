# Visible Ensync Green Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ensync's green unmistakable in persistent brand anchors and active controls while keeping all application surfaces neutral and preserving the current multi-pane interface exactly.

**Architecture:** Keep the change in the existing semantic color layer. Desktop and site source styles receive matching neutral graphite/stone surfaces and vivid green accent tokens; the desktop theme adds only color overrides to existing active-header and ready-action selectors. The installed app is updated by transplanting those color values and rules into its current compiled stylesheet rather than replacing its newer JavaScript, layout CSS, or native shell.

**Tech Stack:** React/Vite CSS, Electron packaged assets, Node.js `node:test`, site validator, macOS ad-hoc code signing, Computer Use visual QA.

## Global Constraints

- Dark accent is `#45d483`; light accent is `#178449`.
- Pane bodies, title bars, activity rails, sidebars, and the general canvas remain neutral graphite or stone.
- The linked-loop mark and active pane/tab header are always-visible green brand anchors.
- Only ready primary actions, selected controls, enabled toggles, focus rings, and status dots use the vivid accent hierarchy.
- Never tint an entire pane as part of the brand theme; unread-completion presentation remains separate and user-selected.
- Preserve typography, spacing, border widths, radii, shadows, decorative geometry, component hierarchy, pane geometry, window-inside-window presentation, responsive layout, controls, and behavior.
- Preserve the current installed app's JavaScript, native shell, Host files, and layout stylesheet byte-for-byte.

---

### Task 1: Lock the desktop color contract

**Files:**
- Create: `host/theme-contract.test.mjs`
- Modify: `src/theme.css:8-83, 2319-2334`

**Interfaces:**
- Consumes: semantic CSS variables already loaded after `src/index.css`.
- Produces: vivid `--accent-ui` tokens plus color-only active-pane, active-tab, mark, focus, status, and ready-send bindings.

- [ ] **Step 1: Write the failing desktop theme contract test**

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../src/theme.css', import.meta.url), 'utf8')

test('desktop theme keeps neutral surfaces and visible green brand anchors', () => {
  assert.match(css, /--surface-canvas:\s*#191919;/)
  assert.match(css, /--accent-ui:\s*#45d483;/)
  assert.match(css, /:root\[data-theme='light'\][\s\S]*--surface-canvas:\s*#f5f5f2;/)
  assert.match(css, /:root\[data-theme='light'\][\s\S]*--accent-ui:\s*#178449;/)
  assert.match(css, /\.wordmark__mark\s*{[^}]*color:\s*var\(--accent-ui\)/s)
  assert.match(css, /\.relay-split-pane--active\s*>\s*\.relay-split-pane-tab[\s\S]*border-bottom-color:\s*var\(--accent-ui\)/)
  assert.match(css, /\.relay-tabs-mode-tab--active[\s\S]*border-color:\s*var\(--accent-ui\)/)
  assert.match(css, /\.composer__toolbar \.send-button--ready[\s\S]*background:\s*var\(--accent-ui\)/)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test host/theme-contract.test.mjs`

Expected: FAIL because the old muted accent and green-tinted surface values remain.

- [ ] **Step 3: Implement the desktop color layer**

Use these dark semantic values in `src/theme.css`:

```css
--surface-canvas: #191919;
--surface-titlebar: #1d1d1c;
--surface-rail: #1a1a19;
--surface-sidebar: #1d1d1c;
--surface-main: #232322;
--surface-elevated: #2d2d2b;
--surface-control: #2b2b29;
--surface-subtle: #282826;
--surface-hover: #32322f;
--surface-active: #3a3a36;
--border-strong: #62625c;
--border-default: #484843;
--border-soft: #363633;
--text-primary: #f0f1ed;
--text-secondary: #c9cbc5;
--text-muted: #a3a59f;
--text-faint: #858780;
--accent-ui: #45d483;
--accent-ui-strong: #70e9a4;
--accent-ui-text: #082514;
--accent-ui-soft: #173a27;
--focus-ring: rgba(69, 212, 131, 0.72);
```

Use these corresponding light values:

```css
--surface-canvas: #f5f5f2;
--surface-titlebar: #fafaf7;
--surface-rail: #efefeb;
--surface-sidebar: #f5f5f2;
--surface-main: #fbfbf8;
--surface-elevated: #ffffff;
--surface-control: #efefeb;
--surface-subtle: #f1f1ed;
--surface-hover: #e8e8e2;
--surface-active: #dfdfd8;
--border-strong: #bdbdb5;
--border-default: #d6d6cf;
--border-soft: #e6e6df;
--text-primary: #242521;
--text-secondary: #5d5f59;
--text-muted: #767872;
--text-faint: #8d8f88;
--accent-ui: #178449;
--accent-ui-strong: #0e6837;
--accent-ui-text: #ffffff;
--accent-ui-soft: #dff3e6;
--focus-ring: rgba(23, 132, 73, 0.62);
```

Add color-only bindings after the established workspace rules:

```css
.relay-split-pane--active > .relay-split-pane-tab {
  border-bottom-color: var(--accent-ui);
  background: color-mix(in srgb, var(--accent-ui) 12%, var(--surface-titlebar));
}

.relay-tabs-mode-tab--active {
  border-color: var(--accent-ui);
  background: color-mix(in srgb, var(--accent-ui) 10%, var(--surface-main));
}

.composer__toolbar .send-button {
  border-color: var(--border-default);
  background: var(--surface-control);
  color: var(--text-faint);
}

.composer__toolbar .send-button--ready,
.composer__toolbar .send-button--ready:hover {
  border-color: var(--accent-ui);
  background: var(--accent-ui);
  color: var(--accent-ui-text);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test host/theme-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run the production build**

Run: `npm run build`

Expected: TypeScript and Vite production build complete successfully.

---

### Task 2: Match the public-site palette

**Files:**
- Create: `site/tests/palette.test.mjs`
- Modify: `site/public/styles.css:1-48, 1347-1415`

**Interfaces:**
- Consumes: the desktop palette values from Task 1.
- Produces: matching site tokens and demo-window color overrides without layout changes.

- [ ] **Step 1: Write the failing site palette test**

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8')

test('site uses the visible Ensync green with neutral surfaces', () => {
  assert.match(css, /--bg:\s*#f5f5f2;/)
  assert.match(css, /--accent:\s*#178449;/)
  assert.match(css, /:root\[data-theme="dark"\][\s\S]*--bg:\s*#191919;/)
  assert.match(css, /:root\[data-theme="dark"\][\s\S]*--accent:\s*#45d483;/)
  assert.match(css, /\.brand-mark,[\s\S]*color:\s*var\(--accent\)/)
  assert.match(css, /\.demo-composer b,[\s\S]*background:\s*#45d483;/)
})
```

- [ ] **Step 2: Run the site palette test and verify RED**

Run: `node --test site/tests/palette.test.mjs`

Expected: FAIL on the old surface and accent values.

- [ ] **Step 3: Implement matching site color tokens**

Copy the Task 1 light/dark surface and accent values into the corresponding `--bg`, `--surface*`, `--line*`, `--text*`, and `--accent*` site variables. Update only hard-coded colors in the palette-only demo-window finish so its neutral surfaces and green action use the same values; do not modify any dimensions, spacing, radii, or selectors.

- [ ] **Step 4: Run site verification**

Run: `npm --prefix site test`

Expected: all site tests and the validator pass.

---

### Task 3: Verify source-level scope

**Files:**
- Verify: `src/theme.css`
- Verify: `site/public/styles.css`
- Verify: `host/theme-contract.test.mjs`
- Verify: `site/tests/palette.test.mjs`

**Interfaces:**
- Consumes: completed source changes from Tasks 1 and 2.
- Produces: evidence that the repository change is color-only and buildable.

- [ ] **Step 1: Run focused and aggregate checks**

Run: `node --test host/theme-contract.test.mjs && npm --prefix site test && npm run build && git diff --check`

Expected: every command exits zero.

- [ ] **Step 2: Inspect the diff for structural changes**

Run: `git diff -- src/theme.css site/public/styles.css host/theme-contract.test.mjs site/tests/palette.test.mjs`

Expected: production CSS changes are limited to color values and color properties; test files contain only assertions for that contract.

---

### Task 4: Apply the palette to the current Applications bundle

**Files:**
- Modify: `/Applications/Ensync.app/Contents/Resources/ui/assets/index-*.css` (resolved from the installed `index.html`)
- Modify: `/Applications/Ensync.app/Contents/_CodeSignature/**` through ad-hoc signing only

**Interfaces:**
- Consumes: current installed bundle and the approved source palette.
- Produces: a relaunched app with current development JavaScript/layout preserved and the visible green palette active.

- [ ] **Step 1: Capture installed hashes and resolve the live stylesheet**

Run a read-only script that records SHA-256 for `app.asar`, every installed JavaScript asset, the layout CSS asset, and the stylesheet referenced by `Contents/Resources/ui/index.html`.

Expected: one exact application stylesheet is resolved before mutation.

- [ ] **Step 2: Create a temporary stylesheet backup and patch only semantic color values and the approved color bindings**

Use a Node script that replaces variables by name inside the existing dark/light semantic blocks and appends or replaces the four approved selectors. The script must reverse its own substitutions against the backup and report that no other compiled CSS bytes changed.

- [ ] **Step 3: Re-sign and verify the bundle**

Run: `codesign --force --deep --sign - /Applications/Ensync.app && codesign --verify --deep --strict /Applications/Ensync.app`

Expected: both commands exit zero.

- [ ] **Step 4: Relaunch and visually verify**

Quit and reopen the installed app, then inspect it through Computer Use.

Expected: the linked-loop mark and active pane edge/header are visibly green at normal scale; ready send actions, selected controls, focus, and status elements use the same green; surfaces remain neutral; the populated multi-pane/window-inside-window UI and active Host jobs restore.

- [ ] **Step 5: Verify installed code and layout preservation**

Recompute hashes recorded in Step 1.

Expected: `app.asar`, JavaScript assets, Host/native resources, and the layout CSS asset are unchanged; only the application stylesheet and signing metadata differ.

---

### Task 5: Final verification and focused commit

**Files:**
- Commit: `src/theme.css`
- Commit: `site/public/styles.css`
- Commit: `host/theme-contract.test.mjs`
- Commit: `site/tests/palette.test.mjs`
- Commit: `docs/superpowers/plans/2026-08-09-visible-green-theme.md`

**Interfaces:**
- Consumes: all completed implementation and verification evidence.
- Produces: one reviewable theme implementation commit while preserving unrelated dirty worktree changes.

- [ ] **Step 1: Run final verification**

Run: `node --test host/theme-contract.test.mjs && npm --prefix site test && npm run build && git diff --check`

Expected: all commands exit zero.

- [ ] **Step 2: Stage only the named theme files**

```bash
git add src/theme.css site/public/styles.css host/theme-contract.test.mjs site/tests/palette.test.mjs docs/superpowers/plans/2026-08-09-visible-green-theme.md
git diff --cached --check
```

Expected: no unrelated file is staged.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: make Ensync green visibly distinct"
```

Expected: the focused implementation commit succeeds and all unrelated worktree changes remain present.

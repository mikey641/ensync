# Active Split-Pane Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the active split-pane tab fully visible when it is selected near either horizontal edge.

**Architecture:** Extend the existing pure split-layout helpers so the component selects the ordinary active pane for viewport alignment whenever no temporary largest pane takes precedence. Reuse the existing minimum-scroll calculation and resize observation, then choose the nearest mandatory CSS snap point that still contains the whole pane; preserve manual horizontal position whenever the selected pane already fits.

**Tech Stack:** React, TypeScript, CSS overflow layout, Node test runner.

## Global Constraints

- Preserve conversation IDs, pane widths, ordering, hidden state, and temporary-largest state.
- Do not force all panes to fit; horizontal scrolling remains supported.
- Do not move the viewport when the selected pane is already fully visible.
- Keep behavior identical on macOS and Windows.
- Keep durable behavior in `.relay/features/workspace-tabs.md`.
- Ensync Host owns the final commit; do not commit or push manually.

---

### Task 1: Align the selected split pane

**Files:**
- Modify: `host/workspace-persistence.test.mjs`
- Modify: `src/lib/splitLayoutPersistence.mjs`
- Modify: `src/lib/splitLayoutPersistence.d.mts`
- Modify: `src/components/SplitWorkspace.tsx`
- Modify: `.relay/features/workspace-tabs.md`

**Interfaces:**
- Consumes: `largestPaneScrollLeft({ scrollLeft, paneLeft, paneWidth, viewportWidth, scrollWidth }): number`
- Produces: `splitPaneAlignmentTabId(viewMode, activeTabId, largestTabId, renderedTabIds): string | null`

- [x] **Step 1: Write the failing regression test**

Add a namespace import for `splitLayoutPersistence.mjs` and assert that its new selector chooses `tab-right` in split mode when no largest pane exists:

```js
test('an ordinary active split pane becomes the viewport alignment target', () => {
  assert.equal(
    splitLayoutPersistence.splitPaneAlignmentTabId?.(
      'split',
      'tab-right',
      null,
      ['tab-left', 'tab-right'],
    ),
    'tab-right',
  )
})
```

This test catches restoring the component's current largest-only alignment decision.

- [x] **Step 2: Run the focused test and verify red**

Run: `node --test --test-name-pattern='ordinary active split pane' host/workspace-persistence.test.mjs`

Expected: one assertion failure because `splitPaneAlignmentTabId` is not implemented and the optional call returns `undefined`.

- [x] **Step 3: Implement the minimum behavior**

In `src/lib/splitLayoutPersistence.mjs`, add:

```js
export function splitPaneAlignmentTabId(viewMode, activeTabId, largestTabId, renderedTabIds) {
  if (viewMode !== 'split') return null
  const rendered = new Set(renderedTabIds)
  if (largestTabId && rendered.has(largestTabId)) return largestTabId
  return activeTabId && rendered.has(activeTabId) ? activeTabId : null
}
```

Declare the exact signature in `src/lib/splitLayoutPersistence.d.mts`. In `SplitWorkspace.tsx`, use this selector in the existing layout effect, add the resolved active tab ID to its dependencies, and pass the selected pane through the current `largestPaneScrollLeft` geometry calculation. Keep the existing `ResizeObserver` behavior so viewport and pane-row size changes cannot re-clip the selected pane.

- [x] **Step 4: Verify green and surrounding behavior**

Run:

```sh
node --test --test-name-pattern='split pane|largest pane|largest-pane' host/workspace-persistence.test.mjs
npm run build
```

Expected: all matching tests pass and the TypeScript/Vite build exits zero.

### Task 2: Make the correction compatible with mandatory scroll snapping

**Files:**
- Modify: `host/workspace-persistence.test.mjs`
- Modify: `src/lib/splitLayoutPersistence.mjs`
- Modify: `src/lib/splitLayoutPersistence.d.mts`
- Modify: `src/components/SplitWorkspace.tsx`

**Interfaces:**
- Consumes: the rendered pane offsets relative to `.relay-split-panes`
- Produces: `largestPaneScrollLeft({ ..., snapPoints?: readonly number[] }): number`

- [x] **Step 1: Write and run the failing snap-point regression**

Use the measured reproduction geometry—`812px` viewport, active pane from `612px` through `918px`, snap points at `0`, `306`, `612`, and `924`—and require a `306px` target. Run:

```sh
node --test --test-name-pattern='scroll-snap point' host/workspace-persistence.test.mjs
```

Expected: FAIL with `106 !== 306`, proving the raw minimum correction is pulled backward by mandatory CSS snapping.

- [x] **Step 2: Select the nearest fully-visible snap point**

Extend `largestPaneScrollLeft` with optional finite snap points. If the pane already fits, keep the current position. Otherwise, for panes no wider than the viewport, find clamped snap positions inside the interval from `paneRight - viewportWidth` through `paneLeft` and return the candidate nearest the current scroll position. Preserve the existing raw target when no compatible point exists or when the pane is wider than the viewport. Pass every rendered pane's row-relative left offset from `SplitWorkspace.tsx`.

- [x] **Step 3: Verify the focused test, build, and visual reproduction**

Run the focused alignment tests and `npm run build`. In the local browser reproduction, confirm the active pane's left and right bounds are both within the split viewport after reload.

- [x] **Step 5: Record the durable rule and run full verification**

Update `.relay/features/workspace-tabs.md` to state that activating a partly visible ordinary split pane minimally scrolls it fully into view while preserving manual scroll when it already fits. Then run:

```sh
npm run lint
npm run test:host
```

Expected: lint and all Host tests exit zero.

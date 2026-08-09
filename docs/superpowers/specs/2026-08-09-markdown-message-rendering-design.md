# Markdown message rendering — design

Date: 2026-08-09. Approved direction: the user reviewed the rendering-stack survey and
delegated the choice ("choose whatever you think fits best").

## Problem

Chat messages render prose as a single `<p>{text}</p>` (`src/components/MessageContent.tsx`);
only fenced code blocks are split out (`src/lib/messageContent.mjs`). Tables, headings,
lists, links, images, blockquotes, and inline formatting arrive as raw Markdown text, and
nothing in the app can open an `https://` link from a message or a referenced file on disk.

## Decision: dependency-free parser in `src/lib`, not react-markdown

The survey recommended react-markdown + remark-gfm. Building here changed that choice:

- Every `src/lib` module is a hand-written dependency-free `.mjs` with a `.d.mts`
  declaration, unit-tested via `node --test` in `host/*.test.mjs`. A markdown parser as
  another such module matches the codebase; a unified/remark dependency tree does not.
- Protected agent worktrees have no `node_modules`, so a new npm dependency cannot even be
  installed or type-checked from where agents work; a pure-lib implementation is fully
  testable with `node --test` alone.
- Bidi rules (dir="auto", `unicode-bidi: plaintext`, no invisible control characters) are
  load-bearing, test-pinned behavior; owning the renderer keeps them exact.

MIT projects (claude-replay's `renderMarkdown`, happy's `parseMarkdown`) demonstrate this
scale of hand-rolled parser is proven for agent-transcript rendering.

## Components

1. **`src/lib/markdown.mjs`** (+ `markdown.d.mts`) — pure functions:
   - `parseMarkdown(value)` → block list. Reuses `parseMessageContent` for fence splitting,
     then parses each text block into: `heading {level, content}`, `paragraph {content}`,
     `table {align, header, rows}` (GFM pipes), `list {ordered, start, items}` with one
     level of nesting via indentation, `blockquote {blocks}`, `rule`, and passes `code`
     through unchanged. Unrecognized text stays a paragraph with newlines preserved
     (existing `white-space: pre-wrap` keeps plain text pixel-identical).
   - `parseInline(text)` → inline nodes: `text`, `strong`, `em`, `del`, `code`,
     `link {href, content}`, `image {src, alt}`, bare-URL autolinks. Backslash escapes for
     Markdown punctuation. `---` is always a thematic break (no setext headings — agent
     output uses `#` headings, and setext would silently convert paragraphs).
   - `classifyLinkTarget(href)` → `{kind: 'external', url}` for http(s)/mailto,
     `{kind: 'file', path}` for `/…`, `~/…`, `file://…`, else `{kind: 'none'}`.
   - `filePathFromText(text)` → path + optional `:line` for inline code that looks like a
     file reference (absolute, `~/`, or relative with `/` and a dotted final segment).
2. **`src/components/MessageContent.tsx`** — renders the block list. New optional prop
   `projectPath` (available as `chat.projectPath` at all three call sites). External links:
   `<a target="_blank" rel="noreferrer">` (Electron's existing `setWindowOpenHandler` /
   `will-navigate` guards route these to the system browser). File links and path-like
   inline code: clickable chip that calls the new `openPath` bridge when running in the
   native shell, plain code otherwise. Images: `http(s)` sources render inline `<img>`
   (no CSP blocks them); local-path images render as an openable file chip — the OS
   viewer is the "display" surface. Tables render inside a horizontally scrollable
   wrapper. Prose blocks keep `dir="auto"`; code stays `dir="ltr"`.
3. **Native file-open bridge** — preload `openPath({path, projectPath})` on new channel
   `ensync:workspace:open-path`; main-process handler expands `~`, resolves relative paths
   against the request's project path, strips trailing `:line[:col]`, requires the file to
   exist, then `shell.openPath`. Returns `{ok, error?}`; the chip surfaces a transient
   "Couldn't open" state on failure. Browser mode simply has no bridge, so chips render
   as plain code there.
4. **CSS** — base layout in `src/index.css`, themed via existing semantic tokens in
   `src/theme.css` (display-preferences rule: no theme-specific hex in components).

## Testing

- New `host/markdown-rendering.test.mjs`: parser unit tests (headings, tables incl.
  alignment and malformed rows, lists, blockquotes, rules, inline formatting, escapes,
  autolinks, link classification, file-path detection) plus source/CSS invariants in the
  style of `host/bidi-rendering.test.mjs`.
- `host/bidi-rendering.test.mjs`: update pinned markup patterns to the new renderer while
  keeping the invariants (dir="auto" prose, LTR code, plaintext bidi CSS, no invisible
  directional characters).
- `desktop/test/project-picker.test.mjs`: add `openPath` to the fixed preload surface and
  invocation assertions.
- `npm run test:host` must pass. `npm run lint` / `vite build` require `node_modules`,
  absent in protected worktrees; attempted best-effort via `npm ci`.

## Out of scope

ANSI-colored terminal segments (execution panel already renders CLI output separately),
syntax highlighting inside code blocks, math, and raw HTML in messages (never interpreted,
by design — text stays text).

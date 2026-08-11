---
name: Message rendering
description: Markdown conversation rendering and native file/link opening rules.
---

# Message rendering

Conversation messages render Markdown through a dependency-free parser in
`src/lib/markdown.mjs` (unit-tested via `host/markdown-rendering.test.mjs`), not a
third-party markdown library. Fenced code is split out first by the existing
`parseMessageContent` fence parser, so code is never reinterpreted; prose that matches no
construct stays a paragraph with its exact line breaks. Raw HTML in messages is never
parsed or injected — the renderer builds React elements only, and
`dangerouslySetInnerHTML` is banned by test.

Supported structure: ATX headings, paragraphs, GFM pipe tables (with per-column
alignment and a horizontally scrollable wrapper), ordered/unordered lists with nesting,
blockquotes, thematic breaks, bold/italic/strikethrough, inline code, links, images, and
bare https autolinks. Setext headings are intentionally unsupported so a `---` divider in
agent output never converts the preceding paragraph into a heading.

Link and file-opening rules:

- `http(s)` and `mailto` links render as anchors with `target="_blank" rel="noreferrer"`;
  the desktop shell's existing window-open and will-navigate guards route them to the
  system browser. Other schemes (`javascript:` and friends) render as plain text.
- Local file references — link destinations that are absolute, `~/`, drive-letter, or
  `file://` paths, and inline code that looks like a file path (optionally with a
  trailing `:line[:column]`) — render as clickable chips only when the native bridge is
  present. The chip calls `ensyncDesktop.openPath` on channel
  `ensync:workspace:open-path`; the main process authorizes the sender, expands `~`,
  resolves relative paths against the chat's project path, retries with the `:line`
  suffix stripped, requires the target to exist, and opens it with the OS default app
  (`shell.openPath`). Failures return `{ ok: false }` and the chip shows a transient
  "Couldn't open" state. Browser mode has no bridge, so these render as plain inline code.
- Images with `http(s)` sources render inline (lazy-loaded, size-capped); local-path
  images render as an openable file chip — the OS viewer is the display surface.

Every prose block keeps the bidirectional-text contract from display preferences:
`dir="auto"` plus `unicode-bidi: plaintext` on paragraphs, headings, list items, table
cells, and blockquotes, while code blocks and inline code stay LTR-isolated. All styling
uses the shared semantic tokens in `theme.css`; the message copy action still copies the
original Markdown source unchanged.

Within a block, phrases written in the opposite direction render inside `<bdi>`. A cursor
from `src/lib/bidiText.mjs` walks one block at a time — across bold, links, and plain text
alike, because a line can start inside a link — and marks the runs to isolate: the base
direction is the first strong letter of each rendered line, that letter is never isolated
so `dir="auto"` still resolves the same direction, and a run ends at the next
base-direction letter or at a quote or bracket that is not inside a word. Digits, prices,
and inner punctuation stay in the phrase they belong to, so an English sentence quoting
Hebrew keeps its closing quote, its `₪4,000`, and its "5 photos" where they were written
instead of having them pulled into the Hebrew run. Both conversation renderers use it, and
isolation is markup only: no directional control characters are ever added to stored or
copied text.

# Message Copy Button

**Status:** Implemented

**Date:** 2026-09-03

## Goal

Give every stored user and agent message a compact ChatGPT-style copy action. The
action copies the message's original Markdown source exactly, regardless of how the
message is rendered, collapsed, or bidirectionally isolated on screen.

## User decisions

- Both user and agent messages receive the copy action.
- The action uses the existing message-action presentation: hidden until pointer hover
  or keyboard focus on devices with hover, and visible on devices without hover.
- Copying preserves the original Markdown source unchanged.

## Selected approach

Reuse the existing `CopyTextButton` and message action row that agent messages already
use. Add the same action row to stored user messages and strengthen its CSS visibility
rules for keyboard and touch access. This keeps clipboard state, accessible labels,
icons, and failure behavior consistent without introducing another component or a
message context menu.

An always-visible desktop action would be easier to discover but would add repeated
chrome beneath every short message. An overflow menu would be visually compact but
would make the common copy operation slower and less discoverable. The selected
hover/focus/touch behavior matches the approved interaction with less complexity.

## UI behavior

- A stored user or agent message exposes one **Copy message** action beneath its
  content and attachments.
- Pointer hover over the message reveals the action row on hover-capable devices.
- Moving keyboard focus into the message reveals the action row before and while the
  button is focused.
- Devices that do not support hover keep the action visible so touch users can reach
  it without a hidden gesture.
- Activating the action writes `message.content`, not rendered text, to the browser or
  desktop renderer clipboard.
- A successful write changes the button's accessible and visible status
  to **Copied**. A rejected or unavailable clipboard reports **Copy failed** and keeps
  the existing explanatory tooltip.
- Pending provider-question preamble messages retain their existing copy action.
  Provider progress notes are not stored transcript messages and remain outside this
  feature.

## Accessibility and styling

The button retains the existing `Copy message` accessible label and live status
announcement. The action row becomes visible through `:focus-within`, so an opacity-
hidden control is not visually lost when reached by keyboard. Touch visibility is
selected with the hover/pointer media capability rather than operating-system or
browser detection. Existing semantic color and focus tokens remain authoritative in
light and dark themes.

## Failure handling

Clipboard unavailability or a rejected write does not alter the message or stored
conversation. The button enters the existing error state and announces the failure;
the user can activate it again. No host API, provider routing, persistence, or native
filesystem behavior changes.

## Testing

Implementation follows test-driven development. A renderer contract test will fail
until it proves that:

- stored user and agent message branches both render `CopyTextButton` with the exact
  `message.content` source and the `Copy message` label;
- message actions are revealed for both message hover and `:focus-within`;
- a no-hover media rule keeps message actions visible for touch input;
- the existing clipboard success, failure, and live-announcement behavior remains in
  the shared component.

After the focused test passes, run the full host test suite, lint, and production build
to catch renderer, type, and styling regressions.

## Non-goals

- Copying attachments or rendered rich-text HTML.
- Adding copy actions to live provider notes, working indicators, or other temporary
  status UI.
- Adding editing, regeneration, rating, sharing, or a general message action menu.
- Changing message persistence, Markdown rendering, provider behavior, or native
  clipboard APIs.

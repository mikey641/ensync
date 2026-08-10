# Live provider notes at completion

## Problem

A completed provider turn can look as though it has no final reply. The Host
does return a verified, non-empty final response, but persisted provider-note
cards remain rendered after the conversation messages when the run is no
longer active. Those stale progress cards push the final reply upward and make
the transcript end on commentary instead of the result.

This conflicts with the existing agent-routing rule: provider notes appear in
the conversation while a run is active and remain available in the
collapsible CLI execution panel afterward.

## Chosen behavior

Provider-note cards are live transcript content only:

- While the chat is sending, show up to the existing six latest provider notes
  below the conversation messages.
- As soon as the run reaches any terminal state, remove those note cards from
  the transcript.
- Do not delete or rewrite the underlying execution events. The CLI execution
  panel continues to expose the complete retained note history.
- On success, the verified agent reply is the last conversation item.
- On failure, interruption, or cancellation, the corresponding error or
  stopped state is the last conversation status.

This applies equally to Codex and Claude note events and to macOS and Windows.

## Alternatives considered

1. Keep note cards permanently but render them before the final reply. This
   makes the reply visible, but completed conversations remain cluttered and
   the behavior still conflicts with the active-only transcript rule.
2. Replace completed note cards with a generated summary card. This introduces
   new state and copy while duplicating information already preserved in the
   execution panel.

The chosen live-only treatment is the smallest change and preserves the
existing separation between conversation output and execution detail.

## Architecture and data flow

The Host protocol, job journal, persistence schema, routing, and final-response
parsing do not change. `ConversationPane` derives transcript-visible notes from
the existing `executionEvents` and current `sending` state. A small pure
presentation helper returns the latest note events only for an active run and
returns an empty list for every terminal state. `ExecutionPanel` continues to
receive the unfiltered execution-event collection.

When a terminal event arrives, the existing completion path appends the agent
message or terminal status and clears the chat's sending state. The derived
live-note list then becomes empty without mutating persisted events. Existing
pane-local auto-scroll behavior reacts to the message and sending-state
revision: pinned panes follow the final reply, while unpinned panes retain the
current Jump to latest behavior.

## Error handling

No new error state is required. Missing or malformed final responses remain
Host errors. Failed, interrupted, and cancelled runs hide transcript note cards
for the same reason as successful runs, while their retained execution events
remain reviewable in the CLI panel.

## Testing

Add a focused behavioral test for the presentation helper that proves:

- an active run returns only note events and retains the existing six-note cap;
- a non-active run returns no transcript notes even when persisted note events
  exist; and
- deriving transcript visibility does not modify the original execution-event
  collection used by the CLI panel.

Run the focused test first in red and green states, then run the Host suite,
TypeScript/Vite build, and lint. No provider process, network call, packaged
desktop build, or release action is required for this renderer-only change.

## Non-goals

- Changing provider note extraction or redaction.
- Removing notes from storage or the CLI execution panel.
- Changing final-response parsing, queue behavior, completion alerts, or unread
  completion markers.
- Altering typography, spacing, or execution-panel presentation.

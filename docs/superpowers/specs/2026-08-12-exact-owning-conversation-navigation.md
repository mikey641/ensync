# Exact Owning Conversation Navigation

## Problem

When a provider recognizes that the requested task belongs to another protected conversation, it can name that conversation's `ensync/chat-…` branch but Ensync can only focus another project or an exact active run. An idle retained conversation cannot be reopened directly. Users can therefore send `continue` repeatedly in the wrong chat while the owning conversation remains safely stored in another Ensync window.

## Decision

Ensync will derive a navigation offer from the latest completed agent message when it references another protected conversation branch. The resolver reads only checksummed snapshots for shell-retained native workspaces and accepts a full branch ID or a shortened hexadecimal prefix of at least six characters. It returns a target only when exactly one different conversation matches.

The conversation pane will show a persistent **Open owning conversation** action with the matched conversation and project names. The action focuses the target native window and opens the exact retained chat. It does not copy, queue, send, or replay the user's message and does not start a provider process.

## Safety boundary

- The resolver never searches arbitrary directories or enters another conversation's worktree.
- Corrupt or unchecksummed storage, an unretained workspace, an ambiguous prefix, a missing project, the current chat, and browser-only mode produce no action.
- Native IPC accepts exact idle-chat navigation as a distinct target shape without a job ID. Exact active-run navigation continues to require the live shell roster.
- The target renderer verifies the native workspace ID, project ID, normalized project path, and chat/project relationship before changing selection.
- Path comparison remains case-insensitive for Windows drive and UNC paths.

## User experience

The banner explains that the task belongs to the named conversation and offers **Open owning conversation**. A failed focus leaves the current chat unchanged and reports an inline error. Ensync never silently transfers a draft or executes `continue` elsewhere.


# Deferred Baseline Reconciliation Design

## Problem

A reused conversation branch is synchronized with the latest canonical `HEAD` during workspace admission. When that merge conflicts, Ensync aborts the merge and rejects admission before a provider process starts. The error tells the person to resolve the protected worktree manually, but other conversations and projects are correctly forbidden from entering it. The bound conversation therefore cannot run the agent needed to reconcile its own work and repeated sends fail identically.

A provider capacity failure after verified activity is a separate safe-fallback case. Ensync correctly preserves and commits that work instead of replaying the turn. Its next manual continuation must be able to reacquire the same conversation branch even if `main` moved meanwhile.

## Considered approaches

1. Keep rejecting admission. This preserves the current invariant but leaves the product deadlocked and requires manual Git work outside the conversation-first interface.
2. Leave the failed merge in progress and start a dedicated resolver before the requested turn. This gives the agent current files, but makes ordinary admission return a deliberately inconsistent worktree and adds a second provider turn before every user continuation.
3. Abort the failed synchronization, retain the exact clean conversation branch, and defer reconciliation to the existing guarded landing pipeline. This is the selected approach. The branch stays recoverable, the requested turn can continue, and the existing conflict-resolution agent, merge conclusion checks, semantic land gate, rollback, and repository lease remain authoritative.

## Workspace contract

When baseline synchronization of a reused protected worktree conflicts:

- Abort the attempted merge so `MERGE_HEAD`, unmerged index entries, and conflict markers are absent before provider execution.
- Return the existing workspace instead of throwing `workspace_baseline_conflict`.
- Attach bounded structured metadata: canonical baseline SHA, sorted conflicted repository paths, and a safe explanation that reconciliation is deferred until landing.
- Report integration as incomplete; never claim the canonical baseline is contained in the conversation branch.
- Skip additional refresh attempts during the same acquisition.
- Keep the workspace lease for the exact conversation through provider execution and automatic landing.

New workspaces, clean baseline synchronization, dirty shared-checkout snapshot safety, duplicate-chat serialization, and cross-project isolation are unchanged.

## Provider and user behavior

The protected-workspace notice and provider isolation preamble state that newer baseline work conflicts in the listed paths, the current branch was preserved cleanly, work may continue, and Ensync will reconcile before landing. The provider must re-read affected files and preserve compatible intent, but must not access another worktree or mutate the canonical checkout.

After a verified successful turn, normal auto-commit runs. Automatic landing then performs its fresh repository-scoped conflict check. If needed, its existing contained conflict-resolution turn merges the latest baseline into this same protected worktree, proves that no unresolved paths or markers remain, runs the repository land gate, and only then lands. Failure leaves the branch unlanded and recoverable.

Capacity or quota failure after activity is never automatically replayed. The saved branch remains resumable, and a later manual message in the same conversation can reacquire it under the deferred-conflict behavior above.

## Failure handling

- Failure to abort the admission merge still fails closed; Ensync must not start a provider in an unverified merge state.
- Malformed or oversized conflict metadata is never exposed; paths originate from Git and remain bounded.
- A conflict-resolution or land-check failure leaves the protected branch unlanded with the existing notices.
- A dirty canonical checkout, lost workspace lease, or lost repository landing lease retains its existing fail-closed behavior.
- The change is local-only. SSH behavior is unchanged.

## Verification

Tests must prove that a conflicting reused workspace is reacquired on its original branch, has no merge in progress, contains the conversation version, exposes exact deferred conflict metadata, and starts the provider in that same worktree. Existing tests must continue proving that clean baseline changes merge before the provider starts and that automatic landing resolves conflicts through a contained agent turn before `main` changes.

# Automatic Remote Push After Landing

## Goal

Automatic landing must publish a successfully integrated FIFO train to the configured Git remote, not stop after updating the local target branch. For a repository with a usable remote, an item is `landed` only after the remote target contains its exact saved commit. Repositories without a configured remote remain local-only.

The current defect is architectural rather than a failed command: `LandingIntegrator` publishes and verifies local `refs/heads/<target>`, while the existing `pushGit` service is available only through the explicit Git-panel route. The landing coordinator never invokes a remote publication operation.

## Publication contract

- Select the remote deterministically using the existing Git status rule: `origin` when present, otherwise the first configured remote.
- Revalidate every configured fetch or push URL for the selected remote with the existing safe remote-location policy before the corresponding network operation. Use only the computer's existing credential helper or SSH agent; Ensync never accepts, stores, or forwards a Git service token.
- Fetch the remote target into a unique tool-owned internal ref for each train. Do not depend on mutable `FETCH_HEAD` or overwrite a user branch or remote-tracking ref.
- If the remote target exists and is not already an ancestor of the local target, incorporate it into the isolated integration worktree before applying or publishing pending chat snapshots. Genuine conflicts use the same bounded, conflict-only automatic resolver and containment checks as chat-item conflicts.
- Preserve completion-order FIFO for chat snapshots. Remote reconciliation is a prerequisite for the train, not another chat item and not a way to reorder completions.
- Publish the verified integration head to the local target under the existing expected-old reference guard, then push that exact verified SHA to `refs/heads/<target>` with an ordinary non-force push.
- Confirm the remote target resolves to the pushed SHA before marking accepted journal items `landed`. A remote race, authentication failure, outage, or rejected push leaves the immutable snapshots in durable `retry` state and never reports a completed remote landing.
- A remote move during publication starts a fresh reconciliation attempt from the new local target and newly fetched remote head. Transient remote failures retry with bounded per-repository backoff while the Host remains online, and remain recoverable at Host startup or the next repository completion. Retrying never replays a provider prompt.
- If the repository has no configured remote, retain today's verified local-only landing behavior. If it has a remote but the target branch does not yet exist there, the ordinary push may create it.

The user's approval of automatic landing authorizes this exact remote publication path, so it does not show a per-train production-push confirmation. Manual Git-panel production pushes retain their existing typed confirmation and are a separate operation.

No path force-pushes, rewrites the remote branch, pushes conversation branches, runs repository scripts or hooks, or creates a `Needs merge review` state.

## Component changes

### Remote publication helper

Add a landing-specific Git helper with a narrow interface: inspect the deterministic remote, validate its fetch and push URLs, fetch one exact target ref into a unique internal ref, push one exact verified SHA, and verify the resulting remote ref. It returns structured outcomes for no remote, missing remote target, success, remote movement, authentication/network failure, and unsafe configuration.

The helper shares the existing command runner, URL validator, redaction, timeouts, argument-array execution, and cross-platform branch validation from `host/git.mjs`. Tests inject a Git runner or use temporary local bare remotes; production tests never contact an external repository.

### Landing integrator

`LandingIntegrator` receives the helper as an injected dependency. At the start of a repository train it captures an immutable remote-target SHA when available. The integration head must retain both the original local target and that fetched remote target before local publication. Post-publication validation additionally proves every accepted saved SHA and the fetched remote SHA are ancestors of the exact local published head.

After local publication, the integrator pushes the pinned published SHA and verifies the remote target. It returns `landedIds` only after that succeeds, except for the explicit no-remote local-only case. If local publication succeeded but remote publication did not, the next attempt recognizes that saved item as locally present but still remote-pending; it reconciles any newer remote head and retries the push instead of incorrectly treating local ancestry as complete.

### Landing coordinator and journal

Keep the existing `queued`, `integrating`, `retry`, and `landed` states. Remote publication failures transition to `retry` with a bounded factual error. The coordinator schedules immediate, one-second, five-second, and thirty-second retry wakeups for remote-transient and remote-moved outcomes, then continues at a capped two-minute interval while the Host remains online. These background retries never keep a chat spinner active. Conflict retries retain the existing startup/new-completion behavior so an unresolved code conflict cannot spin continuously.

Shutdown cancels network operations through the existing abort signal and leaves accepted snapshots durable for restart. Status events distinguish local integration from remote-confirmed landing without exposing credential material or raw remote URLs.

## Ordering and concurrency

One repository still has one coordinator-owned train at a time; different repositories remain concurrent. A completion arriving during remote reconciliation or push joins the next train. The local target and remote target are both checked immediately before their respective mutations. If either moved, the operation fails closed and retries from newly inspected state.

The push uses the train's exact verified SHA rather than whatever `HEAD` happens to name later. This prevents an external local update from broadening the remote publication.

## Failure behavior

- No remote: complete as a local-only landing.
- Unsafe or malformed remote: retry without starting a network command.
- Missing remote target: create it with an ordinary push.
- Remote ahead or diverged: automatically reconcile it in isolation, then publish and push.
- Remote changes after fetch: ordinary push rejects; fetch and retry without force.
- Authentication, network, or timeout failure: keep the item durable and retry with bounded backoff.
- Unresolved content conflict: keep the item durable and retry on startup or the next completion, with no manual-review state.
- Host shutdown: abort safely and recover `integrating` entries as retryable journal work on restart.

## Verification

Tests use temporary repositories and local bare remotes to prove:

1. A clean FIFO train updates both local and remote target refs before journal items become landed.
2. A remote-ahead and a diverged target are incorporated without force, preserving both histories.
3. A remote race rejects the first push, retries from the new remote head, and never rewrites it.
4. A failed push leaves items in durable retry even when their saved commits are already on local `main`.
5. Startup resumes remote-pending work without replaying provider execution.
6. Missing remotes remain local-only; unsafe remotes fail before Git contacts them.
7. Multiple items keep completion FIFO, arrivals during a push enter the next train, and different repositories still push concurrently.
8. Cancellation, cleanup, redaction, macOS/Windows path handling, and the existing local landing gates remain intact.

Run the focused landing, journal, Git workflow, server-integration, and release-compatibility suites, followed by the full release verification before installation.

# Local Update Now With Restart-Surviving Jobs

**Status:** Approved design direction; implementation pending

**Date:** 2026-09-03

## Goal

Add a local-development **Update now** action that installs the newest verified
Ensync `main` build, restarts both the Electron shell and Ensync Host daemon,
and lets already-running provider jobs continue through that restart without
replaying their prompts. New local builds have a deterministic development
identity derived from Git while public stable and beta versions remain under
the existing signed release process.

## User decisions

- This feature updates the developer's local Ensync installation only. It does
  not publish a beta or stable release.
- A local build keeps the product version and adds a unique development build
  label based on the landed commit count and SHA.
- The user explicitly initiates the operation with **Update now**.
- The app shell and Host daemon restart as part of the update.
- Active jobs continue after the restart. They are not cancelled and their
  prompts are not submitted a second time.

## Research and selected approach

Several maintained open-source projects cover adjacent parts of the problem:

- [`semantic-release`](https://github.com/semantic-release/semantic-release)
  publishes a new semantic release from qualifying commits on a release
  branch. [`release-please`](https://github.com/googleapis/release-please)
  instead maintains a release PR that is merged when a release should be cut.
  Both are designed around tags and published releases, not an untagged local
  installation after every Ensync land.
- Electron's
  [`update-electron-app`](https://github.com/electron/update-electron-app)
  downloads published artifacts and requires code-signed macOS builds. It is
  appropriate for Ensync's public release channel, but not for the local
  ad-hoc-signed development bundle or private source checkout.
- [`watchexec`](https://github.com/watchexec/watchexec) and
  [`chokidar`](https://github.com/paulmillr/chokidar) provide cross-platform
  change detection and event coalescing. Watching repository files is weaker
  than consuming Ensync's exact, already-verified `landed` event and can race a
  moving or dirty checkout.
- [`electronmon`](https://github.com/catdad/electronmon) restarts an Electron
  development process after source changes, but it would also replace the
  process that currently owns Ensync's provider streams. It does not preserve
  jobs or update the installed application bundle.

The selected design therefore keeps Ensync's existing guarded installer and
adopts the useful upstream patterns—deterministic Git build identities,
coalesced update requests, and an external restart helper—inside Ensync's
existing trust boundaries. The essential new boundary is a restart-surviving
job worker. No upstream updater can reconstruct a provider process's live
stdin/stdout handles after its parent daemon exits.

## Architecture

### Process boundaries

The current Host combines two responsibilities: the authenticated renderer API
gateway and ownership of provider child processes. Those responsibilities must
be separated for a daemon restart to preserve active work.

Each started provider job receives a dedicated detached Ensync job-worker
process. The worker, rather than the replaceable Host daemon, owns the provider
subprocess, its process group, structured output parser, cancellation signal,
question/permission channel, and live event sequence. It writes a checksummed
bounded event/result journal and a user-only rendezvous descriptor under the
existing Ensync user-data boundary.

The Host daemon remains the single renderer-facing authority. It validates job
requests, creates workers, proxies event subscriptions and controls to the
owning worker, retains terminal results, and owns repository landing. On
startup it discovers descriptors, verifies PID plus process start time, performs
an authenticated protocol handshake, and reattaches the existing job IDs. A
renderer continues using the same opaque job ID and event sequence it already
persists.

The worker owns the run through the provider's exit and the exact conversation-
branch snapshot. If that happens while the Host is restarting, the worker
durably records the saved commit SHA and terminal result. After reattachment,
the Host first imports that exact snapshot into its landing journal and stores
the terminal result in the Host job journal, then acknowledges the worker. The
worker never publishes a target branch and two processes never write the
landing journal concurrently.

Workers are versioned and draining. A worker that began under build A keeps its
loaded build-A runtime until its job reaches a terminal result. After the app
updates to build B, the build-B Host can attach to the documented compatible
worker protocol while every new job starts under build B. The old worker exits
only after its terminal result and final event position have been acknowledged
durably by the new Host. This avoids replacing executable files underneath a
live JavaScript module graph.

### Worker protocol and durable state

The local worker protocol uses loopback transport with a random per-worker
bearer token stored in a mode-`0600` descriptor (and user-scoped Windows ACLs),
matching the existing detached-Host pattern. The renderer never receives the
port, token, source path, executable, or arguments.

The handshake includes:

- protocol version and minimum compatible version;
- exact job ID and request hash;
- worker instance ID, PID, process start time, and loaded Ensync build ID;
- provider ID, state, last durable event sequence, and terminal-result hash.

The worker API is deliberately narrow: health/identity, events after a known
sequence, terminal result, cancel, and the provider-specific live control that
the running adapter already supports. Unknown controls fail closed. A new Host
that cannot satisfy the worker's protocol leaves it running and reports the
version mismatch instead of killing or replaying it.

Worker state contains the minimum data needed to keep the already-started run
alive. It is not account-synced and is deleted after terminal acknowledgement.
Existing redaction and output bounds apply before events are made available to
the Host or renderer. The prompt and full request cross a user-only bootstrap
file once, are removed after the worker has verified its request hash, and are
kept only in worker memory for the remaining run; they are not added to the
rendezvous descriptor or public event journal.

### Update-now flow

**Update now** is a fixed native action in Settings alongside, but separate
from, signed release updates. It is available only when all of the following
are true:

- the installed build is a local `dev` build;
- installation metadata identifies one canonical Ensync source checkout;
- that checkout is the expected Ensync repository on `main`;
- `main` is clean and has a newer landed SHA than the installed source SHA;
- no other local update transaction owns the user-scoped update lock.

The renderer invokes a fixed authorized IPC operation and supplies no path,
command, version, or restart arguments. The native main process and Host derive
those values from verified installation metadata.

The transaction is:

1. Resolve and pin the latest clean `main` SHA. Derive the local display label
   `<product-version>-dev.<first-parent-count>+g<12-char-sha>`.
2. Run the repository's complete local verification/build in a staging area.
   A later landing may update the desired target, but cannot change the pinned
   candidate being verified.
3. Create a complete staged application payload, including renderer, Host,
   daemon bootstrap, Electron main/preload, tools, and build metadata. Verify
   its expected file scope and native bundle identity before shutdown begins.
4. Persist a user-only update transaction record and spawn a detached update
   helper. Only after the helper confirms it owns the record does the app stop
   accepting new job starts. Already-started job workers continue running;
   renderer-local queued prompts remain durably queued.
5. Flush Host job/landing journals, release shell leases, and stop the old Host
   gateway. The helper waits for the Electron shell and Host PIDs to end but
   explicitly excludes every verified job-worker PID and process group.
6. Atomically promote the staged application. Keep the previous application as
   a rollback candidate until native identity/signature checks pass. macOS is
   ad-hoc re-signed for local use; a local Windows development installation uses
   the equivalent staged-directory replacement and never mutates a Microsoft
   Store installation.
7. Relaunch Ensync with inherited daemon/provider environment variables
   removed. The new Host reattaches all compatible live workers before it
   accepts new job starts, then the restored renderers reconnect by existing job
   ID. Queued prompts can begin after reattachment.
8. Remove the rollback and transaction record only after the new shell, Host,
   and worker reconciliation report healthy. If a newer land arrived during
   the transaction, Settings immediately offers that newer target; the running
   update never silently changes its pinned SHA.

The update helper does not run a provider, inspect conversation content, merge
Git branches, or choose a source revision. Its only authority is to promote the
already-verified staged payload described by its transaction record and launch
the fixed Ensync executable.

### Development version identity

Public `desktop/package.json` SemVer and signed stable/beta tags are unchanged.
The build-info schema gains a validated `displayVersion` for local builds. For
example, product version `0.1.0` at first-parent commit 412 and SHA `abc123...`
is displayed as `0.1.0-dev.412+gabc123def456`.

The label is deterministic for a Git commit. Existing `buildId`, full source
SHA, clean/dirty flag, build time, and channel remain available so support can
still distinguish separately produced bytes. Stable and beta build metadata
continue to require an exact product version and do not use the development
label.

### Landing integration

The event-driven landing coordinator's durable `landed` event updates the
latest local candidate for the Ensync source repository. Multiple lands
coalesce to the newest observed target SHA. Landing itself never waits for a
build or update, and an update failure never changes a successful landing
outcome.

The button remains explicit: a land makes a newer local candidate visible but
does not restart the app automatically. Git filesystem watching, polling, and
public GitHub push success are not used as proof that a local land completed.

### UI behavior

The local-development card shows:

- installed development label, build ID, and abbreviated source SHA;
- latest landed local label and whether the source checkout is clean;
- one **Update now** action;
- exact phases: checking, verifying, staging, restarting, reconnecting,
  complete, or failed;
- the count of running workers that will survive the restart and queued prompts
  that will begin afterward.

The confirmation copy states that windows will close and reopen while active
jobs continue in detached workers. Repeated clicks return the same in-progress
transaction. Errors remain visible after relaunch through the transaction
record. Signed-release channel controls retain their current behavior and Store
managed installations never show the local action.

## Recovery and failure handling

- A verification or staging failure occurs before any process shutdown and
  leaves the installed app unchanged.
- If the helper fails before promotion, it relaunches the old app and retains
  diagnostic state.
- If promotion or post-promotion verification fails, the helper restores the
  complete previous bundle before relaunching.
- If the new Host fails to start, workers continue independently and retain
  their journals/descriptors. A later launch can reattach them.
- If a worker itself dies, the existing orphan/reconciliation behavior applies;
  the update mechanism never submits its prompt again.
- A stale transaction or worker descriptor is recoverable only after PID and
  process-start verification proves the recorded owner is gone. PID alone is
  never sufficient.
- Cancellation during preflight is harmless. Once shutdown begins, the
  transaction runs to either verified promotion or rollback so cancellation
  cannot strand half of an application bundle.

## Security and compatibility

- Provider routing remains subscription-only; workers receive the same
  sanitized environment and fixed adapter arguments as the current Host.
- The renderer cannot select executables, source paths, Git revisions, update
  files, worker endpoints, or process IDs.
- Every descriptor, journal, lock, and transaction record is checksummed,
  bounded, user-only, and atomically replaced with a recoverable backup.
- The custom `ensync://app` origin and per-window workspace identities remain
  unchanged.
- Worker protocol compatibility is tested in both directions before a release
  changes the protocol version. A format change cannot ship unless the previous
  supported build's active worker can attach to the new Host.
- macOS and Windows use the same coordinator, state machine, protocol, and
  tests. Only process-liveness, atomic promotion, signing, and launch mechanics
  are platform adapters. Microsoft Store installs remain Store-managed.

## Testing

Implementation follows test-driven development. Tests must prove:

- a fake long-running provider remains the same OS process across termination
  and recreation of the Host gateway;
- the new Host authenticates the worker, replays only missing event sequences,
  delivers one terminal result, and preserves the original job ID;
- cancel and supported live controls reach the reattached worker exactly once;
- incompatible, corrupt, spoofed, reused-PID, and stale descriptors never gain
  control of a worker;
- terminal acknowledgement is crash-safe and cleanup cannot delete a result
  before the Host journal owns it;
- update requests coalesce, pin one clean SHA, reject dirty/non-`main` sources,
  and never block landing;
- build labels are deterministic and stable/beta metadata remains unchanged;
- the detached helper excludes worker process groups, atomically promotes a
  staged fake app, rolls back every injected failure point, and relaunches with
  daemon environment variables removed;
- renderer IPC authorization rejects untrusted windows and ignores all
  renderer-supplied paths or commands;
- macOS and Windows adapters produce the same state transitions, while a Store
  installation cannot enter the local update path;
- existing renderer reload, Host journal recovery, landing, native-update,
  packaging, and release-compatibility suites remain green.

One end-to-end smoke test starts a blocking fake provider, records its PID,
invokes a fake local update, terminates and recreates the Host, releases the
same provider process, and verifies that one continued job result reaches the
restored renderer-facing stream.

## Out of scope

- Publishing Git tags, GitHub releases, beta/stable feeds, or Store packages.
- Automatically updating after every land without the user's button click.
- Replaying prompts after a worker or provider process actually dies.
- Migrating an active worker to newly installed runtime code mid-job.
- Updating provider CLIs; their separate Host-owned maintenance policy remains
  unchanged.

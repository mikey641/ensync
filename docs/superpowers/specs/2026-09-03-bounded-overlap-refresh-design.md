# Bounded overlap refresh design

## Problem

`WorkspaceOverlapMonitor` starts a Git-backed refresh every second. Its current promise chain queues every tick behind the preceding scan. When inspecting many active or unlanded conversation branches takes longer than the polling interval, queued scans accumulate without a bound.

`ChatRunService` performs one final overlap refresh after the provider exits and before it releases the conversation workspace lease. That final refresh joins the end of the accumulated queue. The provider may already have failed and its changed files may already be committed, but the retained Host job cannot publish its terminal error until this cleanup finishes. The renderer therefore continues to show “Working” even though no provider process remains.

## Refresh contract

Each overlap session will permit one active refresh and at most one trailing refresh:

- A refresh requested while idle starts immediately.
- A refresh requested while a scan is active sets one trailing-refresh flag and shares the active operation’s completion promise.
- Any number of additional timer or explicit requests while that trailing scan is pending or running share the current completion promise and cannot extend the drain with a third scan.
- When the active scan completes, exactly one trailing scan runs if one was requested and the session has not stopped.
- A failed active scan reports the advisory failure but still consumes an already requested trailing scan, allowing the bounded retry to recover fresh overlap state.
- `stop()` clears the interval, suppresses a pending trailing scan, waits only for the currently active scan, and then removes the session’s owned activity record.

An explicit final refresh still observes changes that arrive during an active scan because it requests the single trailing scan. Polling cannot build an unbounded backlog.

## Run completion and fallback safety

`ChatRunService` will retain its current ordering: save provider work, finish overlap cleanup, release the workspace lease, and only then let the retained Host job publish success or failure. This avoids reporting a completed run while its protected workspace is still owned.

Once cleanup is bounded, a failure with a Host-verified zero-activity proof reaches the renderer’s existing automatic fallback loop and may switch from Claude to Codex. A failure after tool or file activity remains non-retryable. Ensync will preserve its committed partial work and report the terminal failure; it will not replay the original instruction automatically in another provider.

## Testing

A regression test will use the monitor’s injected interval and Git runner to hold one refresh in progress while firing many polling ticks. It will prove that:

1. repeated ticks do not start or queue repeated Git scans;
2. releasing the active scan runs no more than one trailing scan;
3. stopping the session suppresses trailing work and completes after the active scan;
4. the owned activity record is removed; and
5. existing overlap detection and terminal/fallback tests continue to pass.

The implementation remains platform-neutral and uses no signal or filesystem behavior specific to macOS or Windows.

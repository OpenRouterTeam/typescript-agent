# TLA+ models

TLA+ specifications of the concurrency surfaces in `@openrouter/agent`, model checked with TLC. Each JavaScript synchronous section is one atomic step and each `await` is a point where other actions may interleave, so the models explore the microtask interleavings the runtime can produce without encoding the event loop itself.

## Running

Requires Java 17+ and `tla2tools.jar` from the [TLA+ releases](https://github.com/tlaplus/tlaplus/releases).

```bash
cd specs/tla
java -cp /path/to/tla2tools.jar tlc2.TLC -workers auto -config MultiConsumerStream_active.cfg MultiConsumerStream.tla
```

Every `.cfg` in this directory is expected to pass. The `Fix*` and `CancelledFlag` constants switch a modeled fix on or off, so flipping one to `FALSE` reproduces the counterexample that motivated the change.

## Models

`MultiConsumerStream.tla` covers `ReusableReadableStream` and `ToolEventBroadcaster`: consumer creation, reads, waiting promises, `return()`, active-consumer trimming and compaction, source completion and failure, the two-phase `cancel()`, and the broadcaster's completion cleanup microtask. Invariants check buffer accounting, no reads from cleared or trimmed slots, in-order gap-free delivery, no lost wakeups, and eventual consumer termination. With `CancelledFlag = FALSE` and `AllowLateCreate = TRUE`, TLC finds a consumer created during `cancel()`'s await of the source reader that reads a slot the second backlog sweep cleared. `packages/agent/tests/unit/reusable-stream.test.ts` reproduces that trace against the implementation.

`AsyncRunEndDrain.tla` covers `ModelResult.handleRunEndAsyncTasks` under `onRunEnd: 'drain'` together with `AsyncToolRegistry` settlement. The invariant requires every settled task to be delivered or persisted when the run returns. With `FixDropLeftover = FALSE`, TLC finds a settlement that lands during the last permitted drain turn and is never harvested. `packages/agent/tests/unit/async-tool-background.test.ts` reproduces that trace against the implementation.

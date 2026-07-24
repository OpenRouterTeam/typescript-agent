---
'@openrouter/agent': minor
---

Run-level cancellation and per-request timeout composition.

New `signal` option on `callModel`: aborting it stops the tool-execution loop at the next turn boundary AND aborts the in-flight API request/stream, so a stalled provider fails fast with the abort reason instead of hanging until an outer caller/test timeout. A pre-aborted signal fails before any network dispatch.

`RequestOptions.timeoutMs` (the third `callModel` argument) now reliably bounds *each* request the loop makes even when a signal is present: the underlying SDK skips its own `timeoutMs` wiring whenever a request carries a signal, so the engine composes `{run signal, caller signal, per-request timeout}` via `AbortSignal.any` per dispatch — each request gets a fresh timeout budget (not one shared per-run timer), and whichever bound fires first wins.

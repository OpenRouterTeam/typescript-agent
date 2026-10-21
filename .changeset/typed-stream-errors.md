---
'@openrouter/agent': minor
---

Stream failures are now typed. `response.failed` events, stream-level `error` events, and streams that end without a terminal event surface as `StreamFailedError` (with `kind`, `code`, `errorType`, `response` and a `retryable` hint) on every consumption path, instead of a bare `Error`. Both consume paths (the initial stream and follow-up tool turns) now handle `error` events the same way: an `error` event followed by a completion still resolves, and one followed by the stream ending rejects with that error.

Without tools, the stream getters (`getTextStream()`, `getFullResponsesStream()`, `getItemsStream()`, `getReasoningStream()`, `getToolStream()`, `getToolCallsStream()`) used to end silently when the response failed or was truncated. They now reject with the same `StreamFailedError` that `getText()` throws.

Also exports `StreamStalledError`, which the opt-in stream watchdog raises (wired into `callModel` in a follow-up release).

```ts
import { StreamFailedError } from '@openrouter/agent';

try {
  await result.getText();
} catch (error) {
  if (error instanceof StreamFailedError && error.retryable) {
    // transient server failure (server_error, rate limit, provider overloaded, ...)
  }
}
```

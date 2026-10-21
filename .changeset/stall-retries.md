---
'@openrouter/agent': minor
---

Add `streamTimeout.maxStallRetries`, an opt-in setting that transparently re-issues a model request whose stream stalls before producing any content. It requires `firstContentMs`.

```ts
callModel(client, {
  model: 'openai/gpt-4o',
  input: 'hi',
  streamTimeout: { firstContentMs: 15_000, maxStallRetries: 1 },
});
```

Retries cannot duplicate output. With retries enabled, each request's stream is held back until its first content-bearing (or terminal) event, and earlier metadata events are replayed, so a discarded attempt never reaches a consumer. Stalls after content started are never retried and surface as `StreamStalledError` with `retryable: false`. When the budget is exhausted, the last stall is thrown. A user abort is never retried. With `maxStallRetries` unset or 0, events flow in real time as before.

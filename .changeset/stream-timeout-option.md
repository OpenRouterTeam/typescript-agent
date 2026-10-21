---
'@openrouter/agent': minor
---

Add an opt-in `streamTimeout` option to `callModel` that fails fast on stalled response streams. A stream can return headers and then send only keep-alives or metadata events while no content flows. Transport timeouts never fire in that case, so the run used to hang.

```ts
const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'hi',
  streamTimeout: { firstContentMs: 15_000, contentIntervalMs: 30_000 },
});
```

The deadlines re-arm for every model request in the run: the initial request, each tool round, and final, retry and resume requests. When one expires, the in-flight request is aborted and every consumer rejects with `StreamStalledError`. Its `retryable` getter is true only when no content had arrived. The option composes with `signal` and `RequestOptions.timeoutMs`, and an abort through either is reported as itself, never as a stall. The option is never sent to the API.

Also fixes an unhandled promise rejection when a stream consumer exits early from a tool-enabled run that later fails.

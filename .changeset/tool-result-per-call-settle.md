---
'@openrouter/agent': patch
---

Broadcast each tool call's `tool.result` / `tool.call_output` (and the legacy `tool_result`) the moment that call settles, instead of holding every broadcast until the whole round's `Promise.allSettled` resolves. With serially executing calls (e.g. `maxConcurrency: 1`), stream consumers now see each call complete live rather than all at once when the round ends. (DEV-1067)

**Behaviour change for stream consumers:** within a round, `tool.call_output`, `tool.result` and legacy `tool_result` events now arrive in **completion order**, not call order. Correlate them by `callId` / `toolCallId` rather than by position. Model-facing `function_call_output` items are still assembled in **call order**, so follow-up request input and prompt-cache behaviour don't change.

If a call's `toModelOutput` throws, the round still waits for every sibling call to settle before it rejects with the first error in call order, so no broadcasts or async registrations land after the run has failed. When two `ctx.defer()` calls in the same round claim the same taskId, the earlier call in call order still wins. To make that deterministic, a deferred call's registration and placeholder broadcast wait for earlier calls in the round to settle.

---
'@openrouter/agent': patch
---

Harden approval resumes. `approveToolCalls` / `rejectToolCalls` are now de-duplicated, so a call ID listed twice no longer executes an approval-gated tool twice, and passing the same ID in both lists throws before anything runs. Resuming an `awaiting_approval` or `awaiting_hitl` conversation without any decisions now leaves it paused instead of sending a new model request; `getResponse()` / `getText()` reject with an explicit "awaiting approval" error that lists the pending call IDs (previously the generic "Response not available").

```ts
const result = callModel(client, { model, input: [], tools, state });
// state is awaiting_approval and no decisions were passed:
await result.requiresApproval(); // true, and no request was sent
await result.getResponse(); // throws: Conversation is awaiting approval ... Pending tool call IDs: call_1
```

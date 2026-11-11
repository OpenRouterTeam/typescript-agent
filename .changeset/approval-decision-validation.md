---
'@openrouter/agent': patch
---

Harden approval resumes.

`approveToolCalls` / `rejectToolCalls` are now de-duplicated, so a call ID listed twice no longer executes an approval-gated tool twice (or skips the re-approval a `PreToolUse` argument mutation requires), and passing the same ID in both lists throws before anything runs.

Resuming an `awaiting_approval` conversation without any decision now leaves it paused instead of sending a new model request. Any `input` passed with that call is not sent to the model and not saved to state, including a `function_call_output` for the gated call: only an approve/reject decision releases an approval gate.

An `awaiting_hitl` conversation still resumes the documented way, by passing a `function_call_output` for a paused call in `input` (which runs `onResponseReceived`). Without one, and without decisions, it now stays paused too. A paused status with no pending tool calls continues with a normal request, as before.

While a resume leaves the conversation paused, `getResponse()`, `getText()`, `getToolCalls()` and the stream getters reject with an explicit error that names the pause, lists up to 10 pending call IDs, and says when supplied `input` was dropped (previously the generic "Response not available" / "Stream not initialized"). `requiresApproval()`, `getPendingToolCalls()` and `getState()` keep working.

```ts
const result = callModel(client, { model, input: [], tools, state });
// state is awaiting_approval and no decisions were passed:
await result.requiresApproval(); // true, and no request was sent
await result.getResponse(); // throws: Conversation is awaiting approval ... Pending tool call IDs: call_1
```

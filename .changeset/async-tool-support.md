---
'@openrouter/agent': minor
---

Async tool support: background tools, deferred cross-process tools, per-tool cancellation & timeouts, and tool concurrency controls.

Two new builders cover tools whose results don't arrive within the tool round. The design rule: write an ordinary tool body and return plain values — no sentinel tokens, no mode flags. The SDK owns the pending placeholder (every `function_call` in follow-up history must have a paired `function_call_output`, or providers 400), and delivers the late result as a `tool_task_result` user-role message at a turn boundary — never a second output for the same callId.

**`tool.background()`** — the loop keeps going while the work runs. Work settling within the grace window (`graceMs`, default 250ms) behaves exactly like a regular tool; otherwise the model gets a pending placeholder immediately and the return value is injected when it settles. `asyncTools.onRunEnd` controls end-of-run behavior: `'drain'` (default; bounded wait + up to `maxDrainTurns` extra turns so the final answer incorporates late results), `'detach'`, or `'cancel'`.

**`tool.deferred()`** — the run pauses durably (new `ConversationStatus` member `'awaiting_async_tools'`) for out-of-process completion. `start` returns a plain `{ taskId }` (or `{ output }` for a typed immediate fast path); the built tool carries typed `.resolve()` / `.fail()` / `.cancel()` methods whose `output` is checked against the tool's `outputSchema` at compile time and runtime, callable from any process holding the `StateAccessor`. Double resolution throws `ToolTaskAlreadySettledError` (at-most-once delivery guard, persisted via the new `settledAsyncCallIds` state field). The low-level `resumeToolResults()` handles batches and dynamically-stored tools.

**Cancellation & timeouts** — tool execute contexts now carry `ctx.signal` (fires on run abort, per-tool timeout, `cancelTask`, and `ModelResult.cancel()`), plus `ctx.callId` and `ctx.conversationId` for external-job correlation. Every tool kind accepts `timeoutMs` (run-level default: `toolTimeoutMs`); on deadline the round stops waiting and the model receives `{ error, code: 'tool_timeout' }` — the timeout bounds the round's wait, not the tool body, so signal-ignoring bodies cannot hang the run. **Behavior change:** `ModelResult.cancel()` previously only cancelled the stream; it now also aborts in-flight tool executions and background tasks.

**Concurrency** — `toolConcurrency: number | { round?, background? }` caps round parallelism (unbounded by default, matching previous behavior) and the detached background pool (default 16); per-tool `maxConcurrency` bounds one tool across the run. Output order stays call order regardless of completion order (prompt-cache stability).

**Events** — new `tool.async_started` and `tool.async_settled` stream events (with `delivery: 'injected' | 'pending_resume' | 'dropped'`); background progress reuses `tool.preliminary_result`; `tool.result` still fires exactly once per call with the final value. New `ModelResult.getAsyncTasks()` / `.cancelTask(taskId)`. Doom-loop detection treats a late-result delivery as forward progress (text streak resets) so "still waiting" phrasing between deliveries is not condemned.

State fields (`pendingAsyncTools`, `settledAsyncCallIds`) are additive within ConversationState version 1 — existing blobs load unchanged. New subpath exports: `@openrouter/agent/resume-tool-results`, `@openrouter/agent/tool-concurrency`, `@openrouter/agent/async-tool-registry`.

### API example

```typescript
import { callModel, tool, resumeToolResults } from '@openrouter/agent';
import { z } from 'zod';

// Background: ordinary body; the loop keeps going while it runs.
const renderVideo = tool.background({
  name: 'render_video',
  inputSchema: z.object({ script: z.string() }),
  eventSchema: z.object({ pct: z.number() }),
  outputSchema: z.object({ url: z.string() }),
  ack: 'Rendering started — the result arrives automatically.',
  timeoutMs: 300_000,
  execute: async ({ script }, ctx) => {
    const job = await renderer.start(script, { signal: ctx?.signal });
    for await (const p of job.progress()) ctx?.progress({ pct: p });
    return job.result();                       // just return it
  },
});

// Deferred: start/complete split for webhook-backed work.
const legalReview = tool.deferred({
  name: 'request_legal_review',
  inputSchema: z.object({ contractId: z.string() }),
  outputSchema: z.object({ approved: z.boolean() }),
  start: async ({ contractId }, ctx) => {
    const ticket = await legal.open(contractId, { conversationId: ctx?.conversationId });
    return { taskId: ticket.id };              // pauses: status 'awaiting_async_tools'
  },
});

const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Render the explainer and get it approved',
  tools: [renderVideo, legalReview] as const,
  state,
  toolTimeoutMs: 60_000,
  toolConcurrency: { round: 4 },
  asyncTools: { onRunEnd: 'drain', drainTimeoutMs: 30_000 },
});

for await (const event of result.getFullResponsesStream()) {
  if (event.type === 'tool.async_started') console.log('started', event.taskId, event.mode);
  if (event.type === 'tool.async_settled') console.log(event.status, event.delivery);
}

// Webhook handler — different process, days later. Typed by outputSchema.
await legalReview.resolve(client, {
  state: makeAccessor(conversationId),
  taskId: ticketId,
  output: { approved: true },
  run: { model: 'openai/gpt-4o' },             // continue immediately (omit to record-only)
});
```

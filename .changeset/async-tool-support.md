---
'@openrouter/agent': minor
---

Async tool support: a unified `run()` tool interface with lifecycles, model-side task check-ins, steering, subagent tools (`tool.agent()`), per-tool cancellation & timeouts, and tool concurrency controls.

**One tool interface.** Every tool is declared the same way: a `run` handler (async function or async generator) plus `lifecycle: 'sync' (default) | 'background' | 'deferred'`. Generator yields become the task's log (feeding check-ins, `tool.preliminary_result` events, and transcripts); the generator's return is the result, validated against `outputSchema`. Non-generator bodies log via `ctx.log()`. The released `execute` / `execute: false` / `onToolCalled` forms are unchanged.

- `'background'` — the loop keeps going. Work settling within the grace window (`graceMs`, default 250ms) behaves like a sync call; otherwise the model receives a pending placeholder immediately (satisfying the provider requirement that every `function_call` in follow-up history has a paired output) and the result is injected as a `tool_task_result` user message when it settles. `asyncTools.onRunEnd: 'drain' (default) | 'detach' | 'cancel'` governs run end.
- `'deferred'` — `run` returns `ctx.defer(taskId)` to park the call on durable external work; the run pauses with the new `ConversationStatus` `'awaiting_async_tools'`. The built tool carries typed `.resolve()` / `.fail()` / `.cancel()` completion methods (output checked against `outputSchema` at compile time and runtime), callable from any process holding the `StateAccessor`; `resumeToolResults()` is the low-level batch entry point. Double resolution throws `ToolTaskAlreadySettledError`.

**Model-side check-ins.** An unblocked agent can check on a long-running task by calling the SAME tool with a `taskId` (the pending placeholder tells it how). The engine routes such calls to the tool's `check` config — `check: { schema, execute }` for custom check params (e.g. a `steer` field) and handlers, or the SDK default which answers three views: `status` (state, elapsed, last log), `logs` (last `tail` entries), and `transcript` (full detail). Check handlers receive `turnContext.toolCallStatus`, `turnContext.accumulatedYieldedEvents`, and a `turnContext.task` handle (`statusView` / `tailLogs` / `transcript` / `send` / `cancel`). Check calls are doom-loop-exempt and bypass concurrency/timeout gates. Opt out with `asyncTools: { checkins: false }`. After a process restart, deferred tasks answer `status` from persisted state (including a bounded `lastLog` — a new additive `PendingAsyncTool` field).

**Steering.** Running tasks have an inbox: `run` bodies opt in via `ctx.onMessage(handler)`; deliver from code with `ModelResult.sendToTask(taskId, message)` or from the model via a custom check param forwarded with `turnContext.task.send(...)`. New `ModelResult.queueUserMessage(text)` injects a user message at the next safe turn boundary.

**Subagent tools.** `tool.agent()` creates a tool whose work IS a child `callModel` conversation, running as a background task: the parent loop keeps going, each child turn becomes a log entry, the child conversation is the check-in transcript (`status` adds `turnsCompleted` / `currentActivity`), the `result` mapper (default: `{ text: await child.getText() }`) shapes the delivered output, `cancelTask` / parent abort / `timeoutMs` cancel the child, and steering messages are injected into the child as user messages. Children run in-memory and do not inherit parent hooks (pass child hooks in the `agent` spec explicitly).

**Cancellation & timeouts.** Tool contexts carry `ctx.signal` (fires on run abort, per-tool `timeoutMs` / run-level `toolTimeoutMs`, `cancelTask`, `ModelResult.cancel()`), plus `ctx.callId` / `ctx.conversationId`. Timeouts bound the round's wait, not the tool body (`{ error, code: 'tool_timeout' }`). **Behavior change:** `ModelResult.cancel()` now also aborts in-flight tool work (previously stream-only).

**Concurrency.** `toolConcurrency: number | { round?, background? }` (round unbounded by default; background pool default 16) plus per-tool `maxConcurrency`. Output order stays call order.

**Events.** New `tool.async_started` / `tool.async_settled` (with `delivery: 'injected' | 'pending_resume' | 'dropped'`); progress reuses `tool.preliminary_result`; `tool.result` fires exactly once per call with the final value. `ModelResult.getAsyncTasks()` inspects live tasks. Doom-loop detection treats a late-result delivery as forward progress.

State fields (`pendingAsyncTools` with `lastLog`, `settledAsyncCallIds`) are additive within ConversationState version 1. New subpath exports: `resume-tool-results`, `tool-concurrency`, `async-tool-registry`, `tool-task`, `tool-check`, `agent-tool`.

Note: `tool.background()` and `tool.deferred()` existed only on this PR's branch and were never published; they are replaced by `lifecycle`. No released consumer is affected.

### API example

```typescript
import { callModel, tool } from '@openrouter/agent';
import { z } from 'zod';

// Background: ordinary run; the loop keeps going while it works.
const renderVideo = tool({
  name: 'render_video',
  lifecycle: 'background',
  inputSchema: z.object({ script: z.string() }),
  outputSchema: z.object({ url: z.string() }),
  ack: 'Rendering started.',
  timeoutMs: 300_000,
  check: {
    schema: z.object({
      view: z.enum(['status', 'logs', 'transcript']).optional(),
      steer: z.string().optional(),
    }),
    execute: async (params, turnContext) => {
      if (params.steer) turnContext.task?.send(params.steer);
      return turnContext.task?.statusView();
    },
  },
  run: async function* ({ script }, ctx) {
    const job = await renderer.start(script, { signal: ctx?.signal });
    ctx?.onMessage((msg) => job.reprioritize(msg));
    for await (const p of job.progress()) yield { pct: p };   // → task log + events
    return job.result();                                       // → delivered result
  },
});

// Deferred: durable external work, resumed from any process.
const legalReview = tool({
  name: 'request_legal_review',
  lifecycle: 'deferred',
  inputSchema: z.object({ contractId: z.string() }),
  outputSchema: z.object({ approved: z.boolean() }),
  run: async ({ contractId }, ctx) =>
    ctx!.defer((await legal.open(contractId, { conversationId: ctx?.conversationId })).id),
});

// Subagent: a child conversation as a background tool.
const researcher = tool.agent({
  name: 'research_topic',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  agent: ({ topic }) => ({
    model: 'openai/gpt-4o',
    input: `Research: ${topic}`,
    tools: [searchTool] as const,
  }),
});

const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Render the explainer, get it approved, and research the market',
  tools: [renderVideo, legalReview, researcher] as const,
  state,
  toolConcurrency: { round: 4 },
});

// The model can now check on any running task by re-calling its tool:
//   render_video({ taskId: "task_7f3" })                → status view
//   render_video({ taskId, view: "logs", tail: 5 })     → recent progress
//   research_topic({ taskId, view: "transcript" })      → child conversation
//   render_video({ taskId, steer: "make it shorter" })  → steers the job

// Developer-side observability & control:
result.getAsyncTasks();
result.sendToTask(taskId, 'prioritize accuracy');
result.cancelTask(taskId);

// Webhook handler — different process, days later. Typed by outputSchema.
await legalReview.resolve(client, {
  state: makeAccessor(conversationId),
  taskId: ticketId,
  output: { approved: true },
  run: { model: 'openai/gpt-4o' },
});
```

# @openrouter/agent

## 1.0.0

### Major Changes

- [#110](https://github.com/OpenRouterTeam/typescript-agent/pull/110) [`9766f31`](https://github.com/OpenRouterTeam/typescript-agent/commit/9766f31ec2390cd294ca47dd81d0122941c0d586) Thanks [@LukasParke](https://github.com/LukasParke)! - Stop accumulating generator-tool `preliminaryResults` arrays. Yields are still broadcast live; the terminal `tool.result` event and `ToolExecutionResult` no longer carry the full yield history.

### Minor Changes

- [#118](https://github.com/OpenRouterTeam/typescript-agent/pull/118) [`4dce84e`](https://github.com/OpenRouterTeam/typescript-agent/commit/4dce84e4393ec36745875512d6ad1fcd8b38e502) Thanks [@sambarnes](https://github.com/sambarnes)! - Allow manual tools to provide a caller-owned JSON Schema for wire serialization.

  ```ts
  import { tool } from "@openrouter/agent";
  import { z } from "zod";

  const confirmTool = tool({
    name: "confirm_action",
    inputSchema: z.object({ action: z.string() }),
    wireInputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
      },
      required: ["action"],
    },
    execute: false,
  });
  ```

### Patch Changes

- [#120](https://github.com/OpenRouterTeam/typescript-agent/pull/120) [`ddab365`](https://github.com/OpenRouterTeam/typescript-agent/commit/ddab3652a47edf5ebaa842447864a3dc91b812e5) Thanks [@LukasParke](https://github.com/LukasParke)! - Identify Agent SDK requests with an Agent SDK user-agent suffix that includes the package version.

  ```ts
  import { OpenRouter } from "@openrouter/agent";

  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
  // Requests use the Agent SDK user agent by default.
  // Pass userAgent to override the default identification.
  ```

## 0.11.0

### Minor Changes

- [#109](https://github.com/OpenRouterTeam/typescript-agent/pull/109) [`17418f7`](https://github.com/OpenRouterTeam/typescript-agent/commit/17418f7c469e09efd9d61980315b9727b1d11ff6) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - Add opt-in replay compaction and terminal response-event handling for streamed model calls.

  ```ts
  import { callModel } from "@openrouter/agent";

  const result = callModel(client, {
    model: "openai/gpt-4o",
    input: "Summarize this document.",
    // Retain only the history needed by currently attached consumers.
    streamReplay: "active-consumers",
  });
  ```

### Patch Changes

- [#94](https://github.com/OpenRouterTeam/typescript-agent/pull/94) [`c610b6e`](https://github.com/OpenRouterTeam/typescript-agent/commit/c610b6ef0b880083821afd588717d635943c07ee) Thanks [@LukasParke](https://github.com/LukasParke)! - Fix two ways the tool-approval gate could be bypassed.

  **`allowFinalResponse` executed pending tool calls with no approval check.** When a `stopWhen` condition halted the loop on a turn that still carried tool calls, the final-response path ran those calls directly — skipping the approval gate the normal loop applies on every round. A tool marked `requireApproval: true` (or gated by a predicate) would execute unguarded, and because the `PermissionRequest` hook's deny bookkeeping lives inside the approval check, hook-based `deny` never fired on this path either. That path now runs the same check as the in-loop call sites, so the run pauses with `status: 'awaiting_approval'` and the gated calls on `pendingToolCalls` instead of executing them.

  **Function-based `requireApproval` received unvalidated arguments.** Tool-level and call-level predicates were called with the raw JSON-parsed tool arguments, while `execute` receives the arguments _after_ the tool's Zod `inputSchema` runs. Any default, coercion, or transform in the schema made them disagree — e.g. with `inputSchema: z.object({ dangerous: z.boolean().default(true) })`, a model emitting `{}` showed a predicate `dangerous: undefined` (no approval required) and then executed with `dangerous: true`. Predicates now see a parsed copy, so they decide on exactly what `execute` will receive without mutating the original executable call or parsing transformed output a second time. `PreToolUse` now runs before every auto-resolvable call is partitioned, so approval hooks and persisted pending calls see its effective arguments. Pending calls record an additive marker when preparation ran, preventing a resumed `ModelResult` from applying the hook twice while legacy state without the marker retains its prior behavior. Call-level checks remain unconditional and receive raw arguments when parsing fails; tool-level checks fail closed when schema parsing fails because a hook may later repair the input.

  **Duplicate approval prompts for the same tool call.** The approval gate could run more than once over the same response — e.g. the pre-loop check plus the post-loop `allowFinalResponse` gate when a stop condition fired on the first iteration — re-emitting the `PermissionRequest` hook and re-running `requireApproval` predicates for calls that were already resolved. Each call occurrence in a response is now gated at most once per run, including responses containing duplicate call IDs and arguments.

  ```ts
  import { z } from "zod/v4";
  import { tool, type PendingToolCall } from "@openrouter/agent";

  const deploy = tool({
    name: "deploy",
    inputSchema: z.object({
      environment: z.enum(["staging", "production"]).default("production"),
    }),
    requireApproval: ({ environment }) => environment === "production",
    execute: async ({ environment }) => deployEnvironment(environment),
  });

  // `requireApproval` sees the normalized default: { environment: 'production' }.
  // Persist this additive marker when PreToolUse already produced effective args.
  const pending: PendingToolCall<typeof deploy> = {
    id: "call_deploy",
    name: "deploy",
    arguments: { environment: "production" },
    preToolUseApplied: true,
  };
  ```

- [#112](https://github.com/OpenRouterTeam/typescript-agent/pull/112) [`8a922b5`](https://github.com/OpenRouterTeam/typescript-agent/commit/8a922b5360addf6b5670c7fc4c87780f4fdfa071) Thanks [@LukasParke](https://github.com/LukasParke)! - Add a `./reusable-stream` subpath export so consumers can import `ReusableReadableStream` directly (`@openrouter/agent/reusable-stream`) instead of going through the root barrel or patching the package. Mirrors the existing `./tool-event-broadcaster` entry; both replay classes are the units consumers need when asserting stream-retention behavior against the published package.

- [#111](https://github.com/OpenRouterTeam/typescript-agent/pull/111) [`7416059`](https://github.com/OpenRouterTeam/typescript-agent/commit/7416059a3644af577ef2969b932a6614771e0c43) Thanks [@w0nche0l](https://github.com/w0nche0l)! - Remove the runtime `@openrouter/sdk/models` import from `turn-context.ts`. The namespace import existed only to read `EasyInputMessageRoleUser.User` (the string `'user'`), but it made every consumer that statically imports `@openrouter/agent/tool` (via `agent-tool` → `conversation-state` → `turn-context`) evaluate the entire Speakeasy models barrel — hundreds of modules of top-level Zod schema construction — at module load. On Cloudflare Workers this added ~200ms of startup CPU per worker and pushed large workers past the 1s script-validation ceiling (error 10021).

  The import is now type-only (erased at compile time) and the role literal is inlined, keeping behavior identical. A new unit test walks the static runtime import graph of the hot subpaths (`/tool`, `/tool-types`, `/stop-conditions`) and fails if any of them ever reaches `@openrouter/sdk` at runtime again.

## 0.10.0

### Minor Changes

- [#102](https://github.com/OpenRouterTeam/typescript-agent/pull/102) [`787cbf8`](https://github.com/OpenRouterTeam/typescript-agent/commit/787cbf8b22bf2b8071e81e2dbf84ecd871a5e824) Thanks [@LukasParke](https://github.com/LukasParke)! - Add the full MCP integration under the canonical `@openrouter/agent/mcp` subpath. `@modelcontextprotocol/client` is an optional peer, so base agent installations and imports do not install or load MCP support. The existing `@openrouter/mcp` package remains as a compatibility facade and now re-exports the canonical agent subpaths.

  ```ts
  import { callModel, OpenRouter } from "@openrouter/agent";
  import { createMCPTools } from "@openrouter/agent/mcp";

  const mcp = await createMCPTools({ url: "https://mcp.example.com/mcp" });
  const result = callModel(new OpenRouter(), {
    model: "openai/gpt-4o-mini",
    input: "Use the remote tools.",
    tools: mcp.tools,
  });
  ```

  Install `@modelcontextprotocol/client` alongside `@openrouter/agent` when using `/mcp`. The SDK is loaded lazily, so importing the base agent or the MCP entry point does not require the peer; the first MCP connection attempt without it throws an actionable `MCPMissingPeerDependencyError`.

  Existing `@openrouter/mcp` imports continue to work as tooling-visible deprecated migration facades, but new code should prefer `@openrouter/agent/mcp`. The facade would only be removed in a future breaking release after migration notice.

  The `@openrouter/mcp` facade continues to install `@modelcontextprotocol/client` transitively for backward compatibility; only direct `@openrouter/agent/mcp` users need to add the optional peer explicitly.

- [#31](https://github.com/OpenRouterTeam/typescript-agent/pull/31) [`8d2ed61`](https://github.com/OpenRouterTeam/typescript-agent/commit/8d2ed61964aa063936763c7b80f6b5bf389fa144) Thanks [@mattapperson](https://github.com/mattapperson)! - Add `@openrouter/agent/tool-set` (port of ai-tool-set v1.0.0, MIT © Chris Cook): declarative activate / deactivate / activateWhen / deactivateWhen for tools with state- and context-aware predicates. Integrates with a new `activeTools?: readonly string[]` option on `callModel` that filters which tools are sent to the model for a given call.

  ```ts
  import { callModel, OpenRouter, serverTool, tool } from "@openrouter/agent";
  import { createToolSet } from "@openrouter/agent/tool-set";
  import { z } from "zod/v4";

  type AppContext = { accountId: string };

  // Curried form preserves the literal name for correlated tool event types.
  const listOrders = tool<AppContext>()({
    name: "list_orders",
    inputSchema: z.object({}),
    execute: async (_params, ctx) => ({
      accountId: ctx?.shared.accountId,
      orders: [],
    }),
  });
  // override the default `server:${type}` id
  const search = serverTool(
    { type: "web_search_2025_08_26" },
    { id: "public_search" }
  );

  const toolSet = createToolSet({
    tools: [listOrders, search] as const,
  }).deactivate("list_orders");

  const client = new OpenRouter({ apiKey: process.env["OPENROUTER_API_KEY"] });
  const resolved = toolSet.resolve();

  // resolved.callModel is `{ tools, activeTools }` — spread it straight in
  const result = callModel(client, {
    model: "openai/gpt-4o-mini",
    input: "Search for OpenRouter pricing.",
    ...resolved.callModel,
  });
  ```

- [#114](https://github.com/OpenRouterTeam/typescript-agent/pull/114) [`66d7232`](https://github.com/OpenRouterTeam/typescript-agent/commit/66d7232d53d9881c5842c77f8bc342314724bf3b) Thanks [@mattapperson](https://github.com/mattapperson)! - Add `toolChoice` to `nextTurnParams`, so a tool can change which tools the model may call on the following turn without touching the `tools` array.

  This is what a tool-search tool needs: declare every tool up front, keep the not-yet-needed ones out of reach behind an `allowed_tools` choice, and widen that choice as the model discovers what it wants. Because `tools` is byte-identical across turns, the provider's prompt-cache prefix survives — which is the whole reason to withhold tools rather than send them all.

  ```ts
  import { callModel, OpenRouter, tool } from "@openrouter/agent";
  import { z } from "zod/v4";

  const allowed = (names: string[]) => ({
    type: "allowed_tools" as const,
    mode: "auto" as const,
    tools: names.map((name) => ({ type: "function", name })),
  });

  const toolSearch = tool({
    name: "tool_search",
    inputSchema: z.object({ pattern: z.string() }),
    execute: ({ pattern }) => findMatchingToolNames(pattern),
    nextTurnParams: {
      // Append, never rebuild: dropping a name revokes a tool the model may
      // already have used, and reordering churns the request for nothing.
      toolChoice: ({ pattern }, context) =>
        allowed([
          ...namesIn(context.toolChoice),
          ...findMatchingToolNames(pattern),
        ]),
    },
  });

  const client = new OpenRouter({ apiKey: process.env["OPENROUTER_API_KEY"] });

  const result = callModel(client, {
    model: "openai/gpt-4o-mini",
    input: "What is the weather in Tokyo?",
    tools: [toolSearch, getWeather, sendEmail, listRepos],
    // Only the search tool is reachable until it finds something.
    toolChoice: allowed(["tool_search"]),
  });
  ```

## 0.9.0

### Minor Changes

- [#90](https://github.com/OpenRouterTeam/typescript-agent/pull/90) [`e8d7d6d`](https://github.com/OpenRouterTeam/typescript-agent/commit/e8d7d6dc194dd6029a180a1f23a9935c01c57e6f) Thanks [@LukasParke](https://github.com/LukasParke)! - Async tool support: a unified `run()` tool interface with lifecycles, model-side task check-ins, steering, subagent tools (`tool.agent()`), per-tool cancellation & timeouts, and tool concurrency controls.

  **One tool interface.** Every tool is declared the same way: a `run` handler (async function or async generator) plus `lifecycle: 'sync' (default) | 'background' | 'deferred'`. Generator yields become the task's log (feeding check-ins, `tool.preliminary_result` events, and transcripts); the generator's return is the result, validated against `outputSchema`. Non-generator bodies log via `ctx.log()`. The released `execute` / `execute: false` / `onToolCalled` forms are unchanged.

  - `'background'` — the loop keeps going. Work settling within the grace window (`graceMs`, default 250ms) behaves like a sync call; otherwise the model receives a pending placeholder immediately (satisfying the provider requirement that every `function_call` in follow-up history has a paired output) and the result is injected as a `tool_task_result` user message when it settles. `asyncTools.onRunEnd: 'drain' (default) | 'detach' | 'cancel'` governs run end.
  - `'deferred'` — `run` returns `ctx.defer(taskId)` to park the call on durable external work; the run pauses with the new `ConversationStatus` `'awaiting_async_tools'`. The built tool carries typed `.resolve()` / `.fail()` / `.cancel()` completion methods (output checked against `outputSchema` at compile time and runtime), callable from any process holding the `StateAccessor`; `resumeToolResults()` is the low-level batch entry point. Double resolution throws `ToolTaskAlreadySettledError`.

  **Model-side task interactions.** When any long-running tool is registered, the SDK appends ONE universal `task` tool — a single static wire definition no matter how many async tools exist (per-tool schemas are never augmented; context cost stays constant). The model addresses tasks by `taskId`: `action: 'check' (default) | 'steer' | 'result' | 'cancel'`, with `view: 'status' | 'logs' | 'transcript'` for checks. Calls are engine-intercepted and dispatched to the OWNING tool's `check: { schema, execute }` config when declared (custom `params` validated against `check.schema`), else the SDK default views — universal interface, tool-specific handling. Check handlers receive `turnContext.toolCallStatus`, `turnContext.accumulatedYieldedEvents`, and a `turnContext.task` handle (`statusView` / `tailLogs` / `transcript` / `send` / `cancel`). Task-tool calls are doom-loop-exempt and bypass concurrency/timeout gates. Opt out with `asyncTools: { checkins: false }`. After a process restart, deferred tasks answer `status` from persisted state (including a bounded `lastLog` — a new additive `PendingAsyncTool` field).

  **Steering.** Running tasks have an inbox: `run` bodies opt in via `ctx.onMessage(handler)`; deliver from code with `ModelResult.sendToTask(taskId, message)` or from the model via a custom check param forwarded with `turnContext.task.send(...)`. New `ModelResult.queueUserMessage(text)` injects a user message at the next safe turn boundary.

  **Subagent tools.** `tool.agent()` creates a tool whose work IS a child `callModel` conversation, running as a background task: the parent loop keeps going, each child turn becomes a log entry, the child conversation is the check-in transcript (`status` adds `turnsCompleted` / `currentActivity`), the `result` mapper (default: `{ text: await child.getText() }`) shapes the delivered output, `cancelTask` / parent abort / `timeoutMs` cancel the child, and steering messages are injected into the child as user messages. Children run in-memory and do not inherit parent hooks (pass child hooks in the `agent` spec explicitly).

  **Cancellation & timeouts.** Tool contexts carry `ctx.signal` (fires on run abort, per-tool `timeoutMs` / run-level `toolTimeoutMs`, `cancelTask`, `ModelResult.cancel()`), plus `ctx.callId` / `ctx.conversationId`. Timeouts bound the round's wait, not the tool body (`{ error, code: 'tool_timeout' }`). **Behavior change:** `ModelResult.cancel()` now also aborts in-flight tool work (previously stream-only).

  **Concurrency.** `toolConcurrency: number | { round?, background? }` (round unbounded by default; background pool default 16) plus per-tool `maxConcurrency`. Output order stays call order.

  **Events.** New `tool.async_started` / `tool.async_settled` (with `delivery: 'injected' | 'pending_resume' | 'dropped'`); progress reuses `tool.preliminary_result`; `tool.result` fires exactly once per call with the final value. `ModelResult.getAsyncTasks()` inspects live tasks. Doom-loop detection treats a late-result delivery as forward progress.

  State fields (`pendingAsyncTools` with `lastLog`, `settledAsyncCallIds`) are additive within ConversationState version 1. New subpath exports: `resume-tool-results`, `tool-concurrency`, `async-tool-registry`, `tool-task`, `tool-check`, `agent-tool`. The reserved tool name `task` is rejected by `tool()` and, when supplied dynamically, suppresses the built-in with a warning.

  Note: `tool.background()` and `tool.deferred()` existed only on this PR's branch and were never published; they are replaced by `lifecycle`. No released consumer is affected.

  ### API example

  ```typescript
  import { callModel, tool } from "@openrouter/agent";
  import { z } from "zod";

  // Background: ordinary run; the loop keeps going while it works.
  const renderVideo = tool({
    name: "render_video",
    lifecycle: "background",
    inputSchema: z.object({ script: z.string() }),
    outputSchema: z.object({ url: z.string() }),
    ack: "Rendering started.",
    timeoutMs: 300_000,
    check: {
      schema: z.object({ focus: z.string().optional() }), // validates task({ params })
      execute: async (params, turnContext) => {
        if (params.focus) turnContext.task?.send(params.focus);
        return turnContext.task?.statusView();
      },
    },
    run: async function* ({ script }, ctx) {
      const job = await renderer.start(script, { signal: ctx?.signal });
      ctx?.onMessage((msg) => job.reprioritize(msg));
      for await (const p of job.progress()) yield { pct: p }; // → task log + events
      return job.result(); // → delivered result
    },
  });

  // Deferred: durable external work, resumed from any process.
  const legalReview = tool({
    name: "request_legal_review",
    lifecycle: "deferred",
    inputSchema: z.object({ contractId: z.string() }),
    outputSchema: z.object({ approved: z.boolean() }),
    run: async ({ contractId }, ctx) =>
      ctx!.defer(
        (await legal.open(contractId, { conversationId: ctx?.conversationId }))
          .id
      ),
  });

  // Subagent: a child conversation as a background tool.
  const researcher = tool.agent({
    name: "research_topic",
    inputSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ text: z.string() }),
    agent: ({ topic }) => ({
      model: "openai/gpt-4o",
      input: `Research: ${topic}`,
      tools: [searchTool] as const,
    }),
  });

  const result = callModel(client, {
    model: "openai/gpt-4o",
    input: "Render the explainer, get it approved, and research the market",
    tools: [renderVideo, legalReview, researcher] as const,
    state,
    toolConcurrency: { round: 4 },
  });

  // The model interacts with running tasks through ONE universal tool:
  //   task({ taskId: "task_7f3" })                          → status view
  //   task({ taskId, view: "logs", tail: 5 })               → recent progress
  //   task({ taskId, view: "transcript" })                  → agent child conversation
  //   task({ taskId, action: "steer", message: "shorter" }) → steers the job
  //   task({ taskId, action: "cancel" })                    → stops it

  // Developer-side observability & control:
  result.getAsyncTasks();
  result.sendToTask(taskId, "prioritize accuracy");
  result.cancelTask(taskId);

  // Webhook handler — different process, days later. Typed by outputSchema.
  await legalReview.resolve(client, {
    state: makeAccessor(conversationId),
    taskId: ticketId,
    output: { approved: true },
    run: { model: "openai/gpt-4o" },
  });
  ```

- [#73](https://github.com/OpenRouterTeam/typescript-agent/pull/73) [`78c562e`](https://github.com/OpenRouterTeam/typescript-agent/commit/78c562ef53da0edd84dfbcc6d6ee38a095d72b37) Thanks [@LukasParke](https://github.com/LukasParke)! - Doom-loop detection for the tool-execution loop (opt-in via `doomLoop` on `callModel`).

  Catches runs that stop making progress while continuing to spend: the model re-issuing the same tool call with identical arguments in consecutive rounds (including repeated empty `{}` calls and repeated invalid-JSON calls), repeating identical server-tool requests (`web_search_call` etc., detected post-execution at the step checkpoint), or emitting the same text tokens over and over. Detection is deterministic — a verdict is a pure function of the transcript — and responds through a configurable graduated ladder: `observe` (emit the new `DoomLoopDetected` hook) → `steer` (inject corrective guidance; queued guidance persists across pauses) → `block` (refuse the call with an explanatory tool error, before execution) → `stop` (halt before any further model request; unresolved calls in the final turn get synthesized halt-error outputs so persisted history stays well-formed; `SessionEnd.reason: 'doom_loop'`).

  Streaks are round-scoped: N identical calls fanned out in parallel within one round count once (a streak measures the model re-issuing a call after seeing its result). Tools declare call identity via `loopKey` on the tool definition — a computed function over the call's validated arguments (e.g. `({ command, cwd }) => ({ command, cwd })`; returning `null` exempts a call), or `false` (statically exempt); absent means the full validated arguments. MCP-wrapped tools accept `loopKey` via `markMcp(tool, { loopKey })`. Fingerprints are a cross-port contract: RFC 8785 (JCS) canonicalization + SHA-256 over UTF-8 via WebCrypto, with conformance vectors in `tests/vectors/doom-loop-fingerprints.json` for the Python/Go ports. Unhashable key material (bigint, circular, >64 deep) falls back to the full-arguments identity — detection never fails a run.

  Detector state persists inside `ConversationState.doomLoop`: streaks survive serialize → resume, a `stop` verdict survives decision-only resumes (approve/reject) and clears on a fresh conversational turn, and queued steer guidance is delivered on resume. Ladder configs warn on dead rungs and on `block` with `stop: false` (unbounded block/re-issue). Documented, test-locked limits: varying-input (nonce) loops evade the default identity without a `loopKey`; paraphrased text repetition is not detected; manual/client-executed calls are not recorded. New `@openrouter/agent/doom-loop` subpath exports the primitives; `ModelResult.getDoomLoopVerdict()` reports a stopping verdict.

- [#73](https://github.com/OpenRouterTeam/typescript-agent/pull/73) [`78c562e`](https://github.com/OpenRouterTeam/typescript-agent/commit/78c562ef53da0edd84dfbcc6d6ee38a095d72b37) Thanks [@LukasParke](https://github.com/LukasParke)! - Doom-loop escalation recovery: a new `escalate` ladder rung between `steer` and `block` that unblocks a stuck run by throwing more intelligence at the next turn instead of refusing or halting.

  Configure via `doomLoop.escalation`: `model` runs the NEXT turn on a stronger model (one-turn override, automatic revert), and/or `advisor` forces an `openrouter:advisor` consult (the advisor server tool is appended with `forwardTranscript: true` and loop-diagnosing instructions, and `toolChoice` is pinned to it via `allowed_tools`/`required` so the stuck model must ask for guidance first; an object form passes through as advisor parameters). A user notice naming the detected loop accompanies the escalated turn.

  Escalations are real spend on a run already suspected of wasting it, so they are budgeted: `maxEscalations` (default 2) caps recoveries per conversation, budget is consumed when a recovery is _applied_ (not at verdict time), `escalationsUsed` persists in `ConversationState.doomLoop` so resumes cannot reset it, and concurrent detector verdicts in one window escalate once. Exhausted or unconfigured escalations fall through to the weaker rungs; resolve-time warnings flag an `escalate` rung without a mechanism (and vice versa). The `DoomLoopDetected` hook's `action`/`overrideAction` enums gain `'escalate'` — an override without config/budget downgrades to `observe`, never silently to a stronger action.

- [#89](https://github.com/OpenRouterTeam/typescript-agent/pull/89) [`75271c3`](https://github.com/OpenRouterTeam/typescript-agent/commit/75271c31fdd5ec620f23d75908664b99428d753a) Thanks [@LukasParke](https://github.com/LukasParke)! - Fix doom-loop detection missing a repeated same-tool fan-out.

  Streaks compared a tool's _last_ fingerprint, so `read(a), read(b), read(c)`
  reissued verbatim had a different last call every round and each round's first
  call reset the streak to 1. Eight identical rounds of a three-call fan-out
  produced zero detections, while single-call rounds tripped at round 2 — and
  distinct-argument fan-out is the dominant shape in parallel-tool-calling agents.

  A round's identity for one tool is now the _set_ of fingerprints it was called
  with, compared across rounds. The engine declares a round's complete set before
  any of its calls is scored, so ordering within the round does not matter, a
  changed member resets the streak, and neither a strict subset nor a superset is
  a repeat — a round that adds new work is progress, not repetition. Every call in
  a repeating round reports that round's streak, so at the block rung a repeating
  fan-out stops spending rather than only its last call being refused.

  **Per-call streaks** accumulate alongside the round-set streak, and the
  stronger evidence decides. Each `(tool, arguments)` identity counts its own
  consecutive rounds, whatever its round-mates did — so a call repeating inside
  varying company (`[a,b]`, `[a,c]`, `[a,d]`: `a` is a 3-peat) is flagged even
  though every round's set differs, a repeat keeps counting when a paused HITL
  member drops from the resumed round, and undeclared paths (server-tool records,
  direct callers) get order-independent per-call detection without a declaration.
  When the per-call count alone crosses a rung, only that call is refused and its
  verdict quotes its own identity; genuinely new round-mates run free. For an
  exactly-repeating round both counts are equal, so nothing double-fires. A
  partial repeat (`[a,b,c]` then `[a,b]`) flags the re-issued calls at the
  observe rung rather than being invisible; a superset round (`[a,b]`, `[a,b]`,
  `[a,b,c]`) flags the repeated members while the new call always executes.

  A call that a round's declaration could not include (unhashable key material)
  cannot inherit or move the round's counters; its own verbatim repetition still
  accumulates per-call evidence like any other repeat.

  **Resumed runs**: a multi-call round's fingerprint set and per-call counts are
  persisted alongside its streak (new optional `roundFingerprints` and
  `callStreaks` on `DoomLoopStreak` — additive; pre-existing blobs restore with
  their old single-call semantics). A repeating
  fan-out therefore keeps its evidence across save/resume boundaries: approval
  pauses no longer reset a fan-out sitting at the block rung, and per-turn-resume
  topologies (one `callModel` per user turn, state persisted between) accumulate
  across turns instead of re-baselining on every one. Because the streak travels
  with the exact set that earned it, a resumed round containing only a subset of
  that set is a different round and starts at 1 — a lesser call can never inherit
  a fan-out's evidence. Single-call streaks behave exactly as before.

  **New API**: `DoomLoopMonitor.declareRound(round, calls)` — declares a round's
  complete call set before any of it is scored. `DoomLoopMonitor` is exported, so
  this is a new public method, additive only. Callers using `callModel` need not
  touch it (the engine calls it); direct `DoomLoopMonitor` users and SDK ports
  should, so a repeating fan-out is flagged as one unit (shared verdict, shared
  steer message) rather than only via each member's individual per-call count.

  Single-call round timing, in-round duplicate collapsing, verdict payloads, and
  the number of times a tool's `loopKey` is invoked (once per checked call) are
  unchanged. The persisted shape gains two optional fields (`roundFingerprints`
  and `callStreaks`, both above); everything existing is untouched and old blobs
  restore cleanly with their old semantics.

  **Newly reachable false positive.** The detector compares arguments, not
  results, so repetition shapes that were previously invisible now accumulate and
  are refused at the default `block` rung from round 3. Two variants:

  - A stable _set_ of parallel arguments every round — an agent re-reading the
    same context files each turn, or a fixed fan-out of pollers — blocks with one
    synthesized error per call in the round.
  - A single call re-issued verbatim while its round-mates CHANGE — re-reading an
    anchor file (README, config, schema) while exploring new files each turn
    (`[a]`, `[a,b]`, `[a,b,c]`: `a` blocks from round 3 even though every round
    adds work). The per-call detector counts the call's own consecutive rounds,
    so the round being "progress" does not exempt a member that itself repeats:
    a file already read is in context, and re-reading it is spend without
    progress.

  Exempt such tools with `loopKey: false` (or a `loopKey` returning `null` for
  the call). These classes were invisible to the detector before, so no existing
  exemption covered them; the graduated ladder gives every shape a free round and
  an `observe` warning before anything is refused.

  For `callModel` users, nothing to change — `doomLoop` is configured exactly as
  before, and the engine declares each round for you. What changed is when it
  fires:

  ```ts
  import { callModel } from "@openrouter/agent";

  const result = callModel(client, {
    model: "z-ai/glm-5.2",
    input: "Summarize these files.",
    tools: [readTool],
    // Unchanged config; the ladder default is observe@2, block@3, stop@6.
    doomLoop: true,
  });

  // Say the model reissues the SAME three-call fan-out every round:
  //   round 1: read(a), read(b), read(c)
  //   round 2: read(a), read(b), read(c)   <- identical set
  //
  // was: no detection, ever. Each round's first call reset the streak, so
  //      a fan-out could spin indefinitely while single calls tripped at
  //      round 2.
  // now: round 2 is streak 2 (observe), round 3 is streak 3 (block) — and
  //      EVERY call of the round is refused at the block rung, not just one,
  //      so the fan-out stops spending.
  //
  // A round that ADDS work resets the ROUND streak, but each repeated call
  // keeps its own count — the model re-read a, b, c a third time:
  //   round 3: read(a), read(b), read(c), read(d)
  //            -> a, b, c blocked (3rd consecutive round each); d executes.
  //
  // `loopKey` still runs exactly once per checked call. Persisted state gains
  // two optional fields so fan-out and per-call evidence survive save/resume;
  // old state restores cleanly.
  ```

  Driving `DoomLoopMonitor` directly (or porting it) is the case that needs the
  new call — declare a round's whole batch before recording any of it.
  `resolveDoomLoopOption` and `ResolvedDoomLoopConfig` are now exported too:
  `DoomLoopMonitor` was previously exported without its config resolver, so it
  could not actually be constructed from the public API.

  ```ts
  import { DoomLoopMonitor, resolveDoomLoopOption } from "@openrouter/agent";

  const monitor = new DoomLoopMonitor(resolveDoomLoopOption(true));

  for (const [round, batch] of batches.entries()) {
    // NEW: declare the round's complete set BEFORE recording any of its calls,
    // so a repeating fan-out is scored as one unit. (Per-call repetition is
    // detected either way; the declaration adds whole-round identity.)
    await monitor.declareRound(
      round,
      batch.map((call) => ({
        toolName: call.name,
        keyMaterial: call.arguments,
      }))
    );

    for (const call of batch) {
      const { verdict } = await monitor.recordToolCall(
        call.name,
        call.arguments,
        round
      );
      if (verdict?.action === "block") refuse(call, verdict.message);
    }
  }
  ```

- [#97](https://github.com/OpenRouterTeam/typescript-agent/pull/97) [`a629cf1`](https://github.com/OpenRouterTeam/typescript-agent/commit/a629cf10d8eaf01adeaf04eaedc9061ad55e5db0) Thanks [@LukasParke](https://github.com/LukasParke)! - New `ModelResult.getUsage()` accessor: aggregate token/cost usage across every model call a run made.

  ```ts
  const result = callModel(client, { model, input, tools });

  for await (const item of result.getItemsStream()) {
    render(item);
  }

  // new: aggregate totals across EVERY round of the tool loop
  const usage = await result.getUsage();
  console.log(usage.modelCalls, usage.totalTokens, usage.cost);

  // was (and still is): the FINAL round's response only
  const response = await result.getResponse();
  console.log(response.usage?.totalTokens);
  ```

  `getResponse()` resolves to the _final_ round's response, so in a multi-round tool loop the tokens spent on the intermediate `tool_calls` generations were unreachable — and `getItemsStream()` carries output items only, never surfacing the `response.completed` events that hold each round's usage block. Callers streaming items therefore had no way to account for a run's real token spend without registering a hook.

  `await result.getUsage()` returns the same `SessionUsageTotals` shape as the `SessionEnd` hook's `totalUsage` (`modelCalls`, `inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `reasoningTokens`, and `cost` when the server reported it), summed over the initial request, each tool-round follow-up, the empty-final retry, the `allowFinalResponse` final turn, and approval-resume requests. It gates on run completion like `getResponse()` does, so totals are final whether awaited directly, after `getResponse()`, or after draining any streaming getter — including `getItemsStream()` (on an approval-resumed run, reading usage never advances the tool loop; await `getResponse()`/`getText()` first for final totals there). Unlike `getResponse()` it never rejects (a failed run still consumed tokens), returning the totals accrued so far.

  The usage aggregate is now accumulated independently of the hook system, so it is correct for callers who configured no hooks at all; previously it only advanced as a side effect of `PostModelCall` emission. `SessionEnd.totalUsage` and `getUsage()` read from one snapshot helper and cannot drift.

- [#73](https://github.com/OpenRouterTeam/typescript-agent/pull/73) [`78c562e`](https://github.com/OpenRouterTeam/typescript-agent/commit/78c562ef53da0edd84dfbcc6d6ee38a095d72b37) Thanks [@LukasParke](https://github.com/LukasParke)! - Run-level cancellation and per-request timeout composition.

  New `signal` option on `callModel`: aborting it stops the tool-execution loop at the next turn boundary AND aborts the in-flight API request/stream, so a stalled provider fails fast with the abort reason instead of hanging until an outer caller/test timeout. A pre-aborted signal fails before any network dispatch.

  `RequestOptions.timeoutMs` (the third `callModel` argument) now reliably bounds _each_ request the loop makes even when a signal is present: the underlying SDK skips its own `timeoutMs` wiring whenever a request carries a signal, so the engine composes `{run signal, caller signal, per-request timeout}` via `AbortSignal.any` per dispatch — each request gets a fresh timeout budget (not one shared per-run timer), and whichever bound fires first wins.

- [#99](https://github.com/OpenRouterTeam/typescript-agent/pull/99) [`3028554`](https://github.com/OpenRouterTeam/typescript-agent/commit/3028554bc2aec3e3e415670043777f9898d13681) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - Add `strict` to all client function-tool definitions, including `tool.agent()`, and pass it through serialization instead of hardcoding `strict: null`, so providers can enforce structured-outputs-style schema adherence on tool-call arguments.

  The SDK forwards the caller's generated schema unchanged and propagates provider validation errors. OpenAI-style strict schemas require every object property to be listed in `required`; use Zod `.nullable()` for conceptually optional values because `.optional()` allows the key to be omitted.

  ```ts
  import { tool } from "@openrouter/agent";
  import { z } from "zod/v4";

  const searchTool = tool({
    name: "search",
    inputSchema: z.object({ query: z.string() }),
    strict: true, // was: silently dropped (serialized as strict: null)
    // now: serialized as strict: true on the wire tool definition
    execute: async ({ query }) => runSearch(query),
  });
  ```

### Patch Changes

- [#95](https://github.com/OpenRouterTeam/typescript-agent/pull/95) [`5a7ed03`](https://github.com/OpenRouterTeam/typescript-agent/commit/5a7ed03e5acf47e640ec027dbd3c713f115a054a) Thanks [@LukasParke](https://github.com/LukasParke)! - Clarify the `validateFinalResponse` error messages so an empty final turn can't be misread as "validation rejected my tool call" (issue [#45](https://github.com/OpenRouterTeam/typescript-agent/issues/45)).

  `Invalid final response: empty or invalid output` now names the actual defect: `output array is empty (length 0) for response "<id>"` — with the response id and a pointer to the `strictFinalResponse`/`allowFinalResponse` options — versus `output is not an array (got <type>)` when the payload is malformed. `Invalid final response: missing required fields` now lists which fields were absent (`id`, `output`, or both).

  Diagnostics only — no behavior change. Validation remains a pure array-length check, so tool-call-only output still passes (it always did; that was the misdiagnosis in [#45](https://github.com/OpenRouterTeam/typescript-agent/issues/45)). Both historical message prefixes are unchanged, so any matcher on them keeps working.

- [#91](https://github.com/OpenRouterTeam/typescript-agent/pull/91) [`231fb65`](https://github.com/OpenRouterTeam/typescript-agent/commit/231fb6578e13c0a7578e54b78392f4cff57221c9) Thanks [@w0nche0l](https://github.com/w0nche0l)! - Thread the executed tool call into the hook execute context. `context.toolCall` is part of the tool-facing contract, but only the non-streaming orchestrator populated it — the streaming `ModelResult` loop builds its turn context with just `numberOfTurns`, so `execute` / `onToolCalled` hooks saw `toolCall: undefined` on the streaming path. `buildExecuteCtx` now fills the gap from the executed call: a caller-provided `turnContext.toolCall` still wins (the orchestrator's carries `status`), and otherwise the executed `ParsedToolCall` is converted back to a wire-shaped `FunctionCallItem`. The `onResponseReceived` path intentionally threads nothing — only the `function_call_output` item is in scope there.

- [#100](https://github.com/OpenRouterTeam/typescript-agent/pull/100) [`0efdbb0`](https://github.com/OpenRouterTeam/typescript-agent/commit/0efdbb0cbade947f5ad58a678e97b01f9ead07c9) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - Relax an unchanged forced `toolChoice` (`required`, a specific tool, or `allowed_tools` with `mode: 'required'`) to `auto` after it produces a tool call, including follow-ups resumed after approval, HITL, client-tool, or async-tool pauses. Dynamically resolved choices re-arm when their semantic value changes. This lets the model synthesize a final text answer instead of being forced to call tools until the step budget runs out (DEV-785).

  ```ts
  const result = callModel(client, {
    model: "openai/gpt-4o",
    input: "Plan, research, then submit.",
    tools: [planTool, searchTool, submitTool] as const,
    toolChoice: ({ numberOfTurns }) =>
      numberOfTurns === 0
        ? { type: "function", name: "plan" }
        : numberOfTurns === 3
        ? { type: "function", name: "submit" }
        : "auto",
  });
  ```

## 0.8.0

### Minor Changes

- [#66](https://github.com/OpenRouterTeam/typescript-agent/pull/66) [`c83cceb`](https://github.com/OpenRouterTeam/typescript-agent/commit/c83cceb17ec1d66b9a1fd2d46ac8ac9b6e60fa4c) Thanks [@LukasParke](https://github.com/LukasParke)! - Add a versioned `ConversationState` serialization contract.

  - Optional `version` field on `ConversationState` (absence means v1); `createInitialState` now stamps `version: 1`.
  - New helpers: `serializeConversationState` / `deserializeConversationState` (package root + `@openrouter/agent/conversation-state`).
  - Typed errors: `UnsupportedStateVersionError` (`{found, supported}`) and `InvalidStateError` for malformed payloads.
  - Compat policy: treat JSON as opaque; additive changes within a major; migrations run in `deserializeConversationState` on version bump. StateAccessor load/save is unchanged — helpers are opt-in wrappers over what consumers already do with `JSON.stringify`/`parse`.

- [#68](https://github.com/OpenRouterTeam/typescript-agent/pull/68) [`6807c51`](https://github.com/OpenRouterTeam/typescript-agent/commit/6807c51d56a35e07a2c549d92ab6d8a0c106ac0a) Thanks [@LukasParke](https://github.com/LukasParke)! - The forced final turn after `stopWhen` halts mid-tool-call is now **on by default** and uses `toolChoice: 'none'` instead of stripping `tools` (stripping busted the prompt-cache prefix). It appends a built-in final-answer directive (exported as `DEFAULT_FINAL_RESPONSE_DIRECTIVE`) as the final user message. Previously the final turn required opting in via `allowFinalResponse`, stripped the tools block, and bare `true` appended no directive — models that emit tool-call syntax as text (e.g. GLM) would attempt another tool call and leak unparsed `<tool_call>…` text into the final content (DEV-658).

  ```ts
  callModel(client, {
    model: "z-ai/glm-5.2",
    input: "Research this step by step.",
    tools: [searchTool],
    stopWhen: stepCountIs(3),
    // was: no final turn unless allowFinalResponse was set; bare `true`
    //      stripped tools (cache-busting) and appended no directive, so
    //      GLM-style models could leak raw `<tool_call>…` as the answer
    // now: default-on final turn with toolChoice:'none' (tools kept, cache
    //      preserved) + DEFAULT_FINAL_RESPONSE_DIRECTIVE user message

    // custom wording still overrides the default:
    // allowFinalResponse: 'Summarize what you found.',
    // append no message (turn still happens):
    // allowFinalResponse: '',
    // restore the old opt-out (no final turn, run ends on the tool-call turn):
    // allowFinalResponse: false,
  });
  ```

  Note: runs that previously ended on a halted tool-call turn now make one additional model request by default. Pass `allowFinalResponse: false` to keep the old behavior.

- [#64](https://github.com/OpenRouterTeam/typescript-agent/pull/64) [`e4d06e3`](https://github.com/OpenRouterTeam/typescript-agent/commit/e4d06e38215d6eafbd5c198e3485f476e65d26f0) Thanks [@LukasParke](https://github.com/LukasParke)! - Persist unresolved manual tool calls (`execute: false` / no execute fn) to `ConversationState.pendingToolCalls` when the loop stops, and set status to the new value `'awaiting_client_tools'`.

  Previously, HITL pauses (`onToolCalled → null`) correctly populated `pendingToolCalls` with status `'awaiting_hitl'`, but bare manual tools only `break`'d the loop — `getPendingToolCalls()` returned `[]` and status was left `in_progress`/`complete`. Cold-start consumers could not recover the unresolved calls from serialized state.

  - New `ConversationStatus` value: `'awaiting_client_tools'` (additive; does not replace `'awaiting_hitl'`).
  - Mixed auto+manual rounds still execute/persist regular tool outputs, then pause with only the unresolved manual calls in `pendingToolCalls`.
  - A successful resume with new input from `'awaiting_client_tools'` clears the stale pendings and continues as a normal turn. Failed resume requests leave the paused state intact. Manual tools are not approved/rejected via call IDs (unlike HITL/`awaiting_approval`).

- [#7](https://github.com/OpenRouterTeam/typescript-agent/pull/7) [`80ff8a7`](https://github.com/OpenRouterTeam/typescript-agent/commit/80ff8a730292aa00a3acfcce6ab1e9f5a6a7f0de) Thanks [@mattapperson](https://github.com/mattapperson)! - Add a typed lifecycle hook system to `callModel`, inspired by the Claude Agent SDK hooks pattern.

  Two usage modes: an inline config object (built-in hooks only) or a `HooksManager` instance (custom hooks, dynamic registration via `on()`/`off()`/`removeAll()`, programmatic `emit()`).

  Eight built-in hooks: `PreToolUse` (block or mutate tool input before every client-tool execution), `PostToolUse` / `PostToolUseFailure` (observe results and errors with timing), `UserPromptSubmit` (mutate or reject the prompt before the initial request), `PermissionRequest` (programmatically allow/deny/ask for tools requiring approval), `Stop` (force-resume a halted loop or inject a follow-up prompt, capped against runaway handlers), and `SessionStart` / `SessionEnd` (paired once per run on every exit path, including approval pauses, interruptions, errors, and no-tools streaming paths).

  Features: tool matchers (string / RegExp / predicate), payload filter predicates, sequential mutation piping, short-circuit on block/reject, async fire-and-forget handlers with `drain()` / `abortInflight()` / per-handler timeouts and cooperative cancellation via `ctx.signal`, configurable error handling (`throwOnHandlerError`), and custom hook definitions via Zod schema pairs with full TypeScript inference (transforms/defaults are honored — handlers receive parsed output values).

  The API is additive: existing `onTurnStart`, `onTurnEnd`, and `requireApproval` are unchanged. Public exports: `HooksManager`, `HookName`, `isAsyncOutput`, and the payload/result/config types; also available via the `@openrouter/agent/hooks-manager` subpath.

- [#56](https://github.com/OpenRouterTeam/typescript-agent/pull/56) [`209499a`](https://github.com/OpenRouterTeam/typescript-agent/commit/209499abacd6783ee5c98155bb2a676e3932c3f4) Thanks [@mattapperson](https://github.com/mattapperson)! - Add a `source` discriminant to tool results so untyped MCP tools no longer collapse the type safety of typed tools.

  Previously, mixing an MCP tool (whose output schema is `unknown`) with fully-typed tools in one `callModel({ tools })` array collapsed the entire result union to `unknown` — one untyped tool poisoned every other tool's result type.

  - `ToolExecutionResult` (and `ToolExecutionResultUnion`) now carry `source: 'client' | 'mcp'`. Narrowing on `source === 'client'` recovers the precise, schema-derived results for your own tools; MCP results stay isolated as `unknown` under `source === 'mcp'`.
  - `ToolResultEvent` (streaming: `getFullResponsesStream`, `getToolStream`) gains the same `source` field. **Breaking:** the `tool.result` event payload now includes `source`; consumers that constructed or exhaustively matched these events may need to account for it.
  - `@openrouter/agent` exports a `markMcp()` helper, an `isMcpTool()` guard, and the `McpBranded` type. `@openrouter/mcp` brands every wrapped tool (including synthetic `list_resources`/`read_resource`) so the discrimination is automatic — callers just spread `mcp.tools` as before.
  - MCP tools continue to execute locally and serialize to the wire as `type: 'function'`; the brand is purely informational and does not change runtime behavior.

- [#67](https://github.com/OpenRouterTeam/typescript-agent/pull/67) [`cb83f45`](https://github.com/OpenRouterTeam/typescript-agent/commit/cb83f45209ff66f8c58077f4e0a85d35f884afdb) Thanks [@LukasParke](https://github.com/LukasParke)! - Add a `PostModelCall` lifecycle hook and aggregate usage totals on `SessionEnd` — the telemetry primitives for tracing and benchmark consumers.

  `PostModelCall` fires once per completed model response, on **every** request the agent loop makes: the initial request, each tool-round follow-up, the empty-final retry, the `allowFinalResponse` final turn, and approval-resume requests. The payload carries `responseId` (the OpenRouter generation id, deep-linkable), `model`, `durationMs` (dispatch to fully materialized response, including stream consumption), `turnType` (`'initial' | 'resume' | 'tool_round' | 'final' | 'retry'`), `turnNumber`, and a normalized `usage` block (`inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `reasoningTokens`, `cost?`) when the server reported usage accounting. Purely observational: handlers cannot mutate or block.

  `SessionEnd` now carries an optional `totalUsage` aggregate (`modelCalls` plus the summed usage fields, with `cost` present when any call reported one) whenever at least one model call completed during the run.

  New exported types: `PostModelCallPayload`, `ModelCallUsage`, `SessionUsageTotals`.

### Patch Changes

- [#62](https://github.com/OpenRouterTeam/typescript-agent/pull/62) [`1362232`](https://github.com/OpenRouterTeam/typescript-agent/commit/1362232975f0254343f9842f30ec1b35d391f4fe) Thanks [@LukasParke](https://github.com/LukasParke)! - Docs: fix three README/API drifts found while building production agents — tool context is `ctx.local` (not `ctx.context`); the `state` option takes a `StateAccessor` (`{load, save}`) and state is read via `result.getState()` (not `(await getResponse()).state`); `getToolStream()` emits argument deltas + generator preliminary results, while execution results are on `getFullResponsesStream()`. Adds a streams cheat-sheet table.

- [#65](https://github.com/OpenRouterTeam/typescript-agent/pull/65) [`09a041e`](https://github.com/OpenRouterTeam/typescript-agent/commit/09a041ea717b384c6c85d7c81ef391b170b0dd8f) Thanks [@LukasParke](https://github.com/LukasParke)! - Infer tool context types from `contextSchema` end-to-end: `tool()` now preserves the concrete Zod schema through its overloads, so `execute`'s `ctx.local` is typed from the schema and `callModel`'s `context` map slots accept/reject the real per-tool shape — no more `ctx.local as X` or `context: map as any`. Tools without a `contextSchema` still resolve their map slot to `Record<string, never>`. Types-only; runtime behavior unchanged.

- [#61](https://github.com/OpenRouterTeam/typescript-agent/pull/61) [`c020bc7`](https://github.com/OpenRouterTeam/typescript-agent/commit/c020bc7c86d2f743ecf9158ca3c9ff7b315e43b3) Thanks [@LukasParke](https://github.com/LukasParke)! - Fix: bare string `input` is now normalized into a message item when resuming a conversation with loaded history. Previously the raw string was appended to the request input array un-normalized, causing an OpenResponses 400 validation error on the advertised string-input style.

- [#63](https://github.com/OpenRouterTeam/typescript-agent/pull/63) [`d96cd9f`](https://github.com/OpenRouterTeam/typescript-agent/commit/d96cd9fc589c27978bcdc2fd1921f754be88e3f0) Thanks [@LukasParke](https://github.com/LukasParke)! - Tolerate empty final `output` after completed tool rounds: retry the follow-up request once, then resolve successfully with empty text instead of throwing `Invalid final response: empty or invalid output`. Mini-class models intermittently treat a successful tool call as the terminal answer. Opt into the old throw with `strictFinalResponse: true`. Runs with no completed tool work still throw on empty output.

- [#59](https://github.com/OpenRouterTeam/typescript-agent/pull/59) [`8edae63`](https://github.com/OpenRouterTeam/typescript-agent/commit/8edae63f4f6fe89e146f3abbf6d24dab7a164681) Thanks [@ayush-or](https://github.com/ayush-or)! - Stop the tool-execution loop when a round contains unresolved manual (client-executed) tool calls, instead of sending a follow-up request whose input carries a `function_call` with no matching `function_call_output` — a history providers reject with a 400 "No tool output found for function call ...". The response is surfaced so the caller can execute the manual calls and continue, mirroring the existing all-manual behavior.

## 0.7.2

### Patch Changes

- [#53](https://github.com/OpenRouterTeam/typescript-agent/pull/53) [`a5341f2`](https://github.com/OpenRouterTeam/typescript-agent/commit/a5341f21555b5d2d982484c199d7d9c3093eabe6) Thanks [@Cybourgeoisie](https://github.com/Cybourgeoisie)! - Bump @openrouter/sdk to 0.13.7

## 0.7.0

### Minor Changes

- Add `allowFinalResponse` option to `callModel`, sibling of `stopWhen`. When the agent loop is halted by `stopWhen` while the last model response still contains tool calls, the pending tool calls are executed (so they have matching outputs) and one more model request is made with no tools so the loop ends with a natural-language summary instead of an unfinished tool call. Passing a string instead of `true` additionally appends that string as a final `user` message (e.g. `allowFinalResponse: 'Please summarize what you found.'`). The full accumulated input array and the original `instructions` are sent.

## 0.6.0

### Minor Changes

- [#42](https://github.com/OpenRouterTeam/typescript-agent/pull/42) [`8e71f06`](https://github.com/OpenRouterTeam/typescript-agent/commit/8e71f06024f41e60ccdc68577016637a31912779) Thanks [@mattapperson](https://github.com/mattapperson)! - Remove implicit 5-step cap in `callModel`. When `stopWhen` is omitted, the tool-execution loop now runs until the model produces a turn with no tool calls instead of stopping at 5 steps. Pass an explicit `stopWhen` (e.g. `stepCountIs(n)`, `maxCost(...)`, `maxTokensUsed(...)`) to bound iterations.

## 0.5.0

### Minor Changes

- Add human-in-the-loop (HITL) tool type, a new `ClientTool` variant that sits
  between regular `execute` tools and `manual` tools. HITL tools define two
  async hooks:

  - `onToolCalled(input, context)` runs when the model invokes the tool.
    Return a value to feed the model directly (like a regular `execute` tool),
    or return `null` to pause the conversation so the caller can supply the
    output later — the same flow used by manual tools.
  - `onResponseReceived(rawResult, context)` runs on the next turn when an
    incoming `function_call_output` matches a prior call of this tool. It lets
    the caller transform or validate the raw response before it reaches the
    model. Throwing surfaces as a tool error to the model.

  HITL tools require an `outputSchema`, which is used to validate both the
  `onToolCalled` return value (when non-null) and caller-supplied responses
  (after any `onResponseReceived` transform, or as-is when no hook is defined).

  New `ConversationStatus` value `'awaiting_hitl'` is emitted when one or more
  HITL tools return `null` from `onToolCalled`, signaling that the caller
  should resume with outputs for the paused calls.

  New public exports:

  - Types: `HITLTool`, `HITLToolFunction`
  - Guards: `isHITLTool`, `isAutoResolvableTool` (true for execute / generator
    / HITL tools — i.e. anything that can resolve within a turn)

  `isManualTool` now returns `false` for HITL tools, so existing manual-tool
  branches continue to behave correctly.

### Patch Changes

- [#34](https://github.com/OpenRouterTeam/typescript-agent/pull/34) [`61aca10`](https://github.com/OpenRouterTeam/typescript-agent/commit/61aca10fd9434fe69fbe1e069e4b1858613a7da7) Thanks [@w0nche0l](https://github.com/w0nche0l)! - Detect streamed Responses API results by readable stream behavior instead of constructor names or unsupported adapters.

## 0.4.0

### Minor Changes

- [#30](https://github.com/OpenRouterTeam/typescript-agent/pull/30) [`e4e3ed5`](https://github.com/OpenRouterTeam/typescript-agent/commit/e4e3ed5e0a4f132e8cae1c33d7831f65aa46c211) Thanks [@mattapperson](https://github.com/mattapperson)! - Add `serverTool()` factory for OpenRouter's server-executed tools (web search, `openrouter:datetime`, image generation, MCP, file search, code interpreter, and future SDK additions). Server tools can be mixed with client `tool()`s in the `callModel({ tools })` array; OpenRouter runs them and their output items flow through the unified `ModelResult.allToolExecutionRounds[].toolResults` list.

  - `getItemsStream()` yields server-tool output items (e.g. `web_search_call`, `openrouter:datetime`) alongside client `function_call` / `function_call_output` items. The yielded union is narrowed from the `TTools` passed to `callModel`, so consumers only see item types that are reachable for their tool set.
  - `StepResult.serverToolResults` exposes provider-side tool invocations to `stopWhen` conditions (the existing `toolResults` field remains client-tool-only).
  - New public exports: `serverTool`, `isServerTool`, `isClientTool`, and the types `ServerTool`, `ServerToolConfig`, `ServerToolType`, `ServerToolResultItem`, `ClientTool`, `ToolResultItem`.

### Patch Changes

- [#25](https://github.com/OpenRouterTeam/typescript-agent/pull/25) [`ec94de8`](https://github.com/OpenRouterTeam/typescript-agent/commit/ec94de8c16fa114ba1e6369db25b4a2cd4ebc359) Thanks [@jakobcastro](https://github.com/jakobcastro)! - Bump @openrouter/sdk from 0.11.2 to 0.12.12, which adds `xhigh` and `max` to the `Verbosity` enum for `TextExtendedConfig`

## 0.3.3

### Patch Changes

- [#27](https://github.com/OpenRouterTeam/typescript-agent/pull/27) [`ef15761`](https://github.com/OpenRouterTeam/typescript-agent/commit/ef157612ca213d23ef1bfbfec012db09144315bf) Thanks [@mattapperson](https://github.com/mattapperson)! - Fix `hooks` constructor option silently no-oping when a plain hook object (e.g. `{ beforeRequest: ... }`) was passed: the underlying SDK only honors `hooks` when it is an `SDKHooks` instance, and the previous wrapper forwarded the plain object unchanged.

  `new OpenRouter({ hooks })` now accepts any of:

  - an `SDKHooks` instance (used as-is),
  - a single hook object (`BeforeRequestHook`, `AfterSuccessHook`, etc.), or
  - an array of hook objects.

  Shorthand inputs are normalized into an `SDKHooks` instance before handoff. Hook types (`BeforeRequestHook`, `BeforeRequestContext`, `AfterSuccessHook`, `SDKHooks`, etc.) are now re-exported from the package entry point.

## 0.3.1

### Patch Changes

- [#22](https://github.com/OpenRouterTeam/typescript-agent/pull/22) [`ab5a75c`](https://github.com/OpenRouterTeam/typescript-agent/commit/ab5a75c43d75f33c0a12e4558c11fd98457d2a6c) Thanks [@mattapperson](https://github.com/mattapperson)! - Fix type exports and add pre-push hooks

  - Add `NewDeveloperMessageItem` type export for manually added developer messages
  - Fix `FieldOrAsyncFunction` type import path in async-params module
  - Add `.npmignore` to exclude development files from published package
  - Add husky pre-push hooks for lint and typecheck validation

## 0.3.0

### Minor Changes

- [#19](https://github.com/OpenRouterTeam/typescript-agent/pull/19) [`2b23076`](https://github.com/OpenRouterTeam/typescript-agent/commit/2b2307683b55debcd406eb68a3b95030a14bfaaf) Thanks [@mattapperson](https://github.com/mattapperson)! - Re-export SDK model types and add clean item type aliases so consumers don't need to depend on `@openrouter/sdk` directly.

### Patch Changes

- [#20](https://github.com/OpenRouterTeam/typescript-agent/pull/20) [`f0d2d72`](https://github.com/OpenRouterTeam/typescript-agent/commit/f0d2d72d042c2acb73d911c5aeb40ccb72ffaf9f) Thanks [@mattapperson](https://github.com/mattapperson)! - Re-export `EasyInputMessageContentInputImage`, `OutputInputImage`, and `OpenAIResponsesToolChoiceUnion` from `@openrouter/sdk/models` so consumers can use these types without a direct SDK dependency.

## 0.2.0

### Minor Changes

- Re-export SDK model types (`ResponsesRequest`, `OutputMessage`, `FunctionCallItem`, etc.) from `@openrouter/sdk/models` so consumers don't need a direct dependency on `@openrouter/sdk`.
- Add clean item type aliases (`Item`, `UserMessageItem`, `AssistantMessageItem`, `FunctionResultItem`, etc.) via new `@openrouter/agent` exports.
- Add `OpenRouter` wrapper class that extends `OpenRouterCore` for a simplified API (`@openrouter/agent/openrouter`).

### Patch Changes

- Replace ESLint with Biome for linting and formatting.
- Add CI auto-release workflow on push to main.
- Correct item type aliases to match SDK runtime types.

## 0.1.2

### Patch Changes

- [#13](https://github.com/OpenRouterTeam/typescript-agent/pull/13) [`93a88a8`](https://github.com/OpenRouterTeam/typescript-agent/commit/93a88a875dcce623202b6747843d3d513f032d12) Thanks [@mattapperson](https://github.com/mattapperson)! - fix: export OpenRouter class from package entry point

## 0.1.1

### Patch Changes

- [#4](https://github.com/OpenRouterTeam/typescript-agent/pull/4) [`546b07d`](https://github.com/OpenRouterTeam/typescript-agent/commit/546b07df300d829bdb9f867cd9c24f60d3337ce2) Thanks [@robert-j-y](https://github.com/robert-j-y)! - Fix type errors in test mocks, add null→undefined sanitization in applyNextTurnParamsToRequest, and release-gate publishing via workflow_dispatch

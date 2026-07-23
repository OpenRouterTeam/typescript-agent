# OpenRouter Agent (Beta)

Agent toolkit for building AI applications with [OpenRouter](https://openrouter.ai) — tool orchestration, streaming, multi-turn conversations, and format compatibility.

> [!IMPORTANT]
> This SDK is currently in beta. There may be breaking changes between versions.
> We recommend pinning to a specific version in your `package.json`.

## Installation

```bash
# npm
npm install @openrouter/agent

# pnpm
pnpm add @openrouter/agent

# bun
bun add @openrouter/agent

# yarn
yarn add @openrouter/agent
```

> [!NOTE]
> This package is ESM-only. If you are using CommonJS, you can use `await import('@openrouter/agent')`.

## Quick Start

```typescript
import OpenRouter from '@openrouter/sdk';
import { callModel, tool } from '@openrouter/agent';
import { z } from 'zod';

const client = new OpenRouter({ apiKey: 'YOUR_API_KEY' });

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  inputSchema: z.object({ location: z.string() }),
  execute: async ({ location }) => ({
    temperature: 72,
    condition: 'sunny',
    location,
  }),
});

const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'What is the weather in San Francisco?',
  tools: [weatherTool] as const,
});

// Get the final text response (tools are auto-executed)
const text = await result.getText();
console.log(text);
```

## Features

### Multiple Response Consumption Patterns

`callModel` returns a `ModelResult` that supports many ways to consume the response — all usable concurrently on the same result:

```typescript
const result = callModel(client, { model, input, tools });

// Await the final text
const text = await result.getText();

// Await the full response with usage data
const response = await result.getResponse();
console.log(response.usage); // { inputTokens, outputTokens, cost, ... }

// Stream text deltas
for await (const delta of result.getTextStream()) {
  process.stdout.write(delta);
}

// Stream reasoning deltas
for await (const delta of result.getReasoningStream()) {
  process.stdout.write(delta);
}

// Stream tool-call argument deltas (plus preliminary results from generator tools)
for await (const event of result.getToolStream()) {
  console.log(event); // { type: 'delta', content: '...' } | { type: 'preliminary_result', ... }
}

// Stream all response events, including tool execution results
for await (const event of result.getFullResponsesStream()) {
  // includes tool.result / tool.call_output events
}

// Stream structured tool calls
for await (const toolCall of result.getToolCallsStream()) {
  console.log(toolCall.name, toolCall.input);
}

// Get all tool calls after completion
const toolCalls = await result.getToolCalls();
```

What each stream emits:

| Method | Emits |
|---|---|
| `getTextStream()` | assistant text deltas |
| `getReasoningStream()` | reasoning deltas |
| `getToolStream()` | tool-call **argument deltas**; `preliminary_result` events for generator tools — *not* execution results |
| `getToolCallsStream()` | parsed tool calls as they complete |
| `getItemsStream()` | all output items (messages, function calls, …) |
| `getFullResponsesStream()` | every response event, including `tool.result` / `tool.call_output` execution events |

### Tool Types

The `tool()` factory creates type-safe tools with full Zod schema inference. Three tool types are supported:

**Regular tools** — automatically executed by the agent loop:

```typescript
const searchTool = tool({
  name: 'search',
  description: 'Search the web',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ results: z.array(z.string()) }),
  execute: async ({ query }) => {
    const results = await performSearch(query);
    return { results };
  },
});
```

**Generator tools** — stream intermediate events during execution:

```typescript
const analysisTool = tool({
  name: 'analyze',
  inputSchema: z.object({ data: z.string() }),
  eventSchema: z.object({ progress: z.number() }),
  outputSchema: z.object({ summary: z.string() }),
  execute: async function* ({ data }) {
    yield { progress: 0.5 };
    // ... processing ...
    return { summary: 'Analysis complete' };
  },
});
```

**Manual tools** — reported to the model but not auto-executed (for human-in-the-loop flows):

```typescript
const confirmTool = tool({
  name: 'confirm_action',
  inputSchema: z.object({ action: z.string() }),
  execute: false,
});
```

### Stop Conditions

Control when the agent loop stops executing tools:

```typescript
import { callModel, stepCountIs, hasToolCall, maxTokensUsed, maxCost } from '@openrouter/agent';

const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Research this topic thoroughly',
  tools: [searchTool, summarizeTool] as const,
  // Single condition
  stopWhen: stepCountIs(10),
  // Or combine multiple (stops when ANY condition is met)
  stopWhen: [stepCountIs(10), maxCost(0.50), hasToolCall('summarize')],
});
```

Built-in stop conditions:

| Condition | Description |
|---|---|
| `stepCountIs(n)` | Stop after `n` tool execution steps (default: 5) |
| `hasToolCall(name)` | Stop when a specific tool is called |
| `maxTokensUsed(n)` | Stop when total tokens exceed a threshold |
| `maxCost(dollars)` | Stop when total cost exceeds a dollar amount |
| `finishReasonIs(reason)` | Stop on a specific finish reason |

**Final response after stop**

When `stopWhen` fires while the model is still emitting tool calls, the
loop makes one more model turn with `toolChoice: 'none'` so the run ends
with a natural-language answer instead of a half-finished tool call.
Tools stay in the request — only calling is forbidden — which preserves
the prompt-cache prefix. **This is on by default**; `allowFinalResponse`
tunes it:

```typescript
callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Research this topic',
  tools: [searchTool] as const,
  stopWhen: stepCountIs(5),
  // default (omitted or `true`): appends DEFAULT_FINAL_RESPONSE_DIRECTIVE
  // as a final user message so the model writes an answer instead of
  // attempting another tool call

  // override the directive wording:
  // allowFinalResponse: 'Please summarize what you found.',
  // append no message (turn still happens, calls still forbidden):
  // allowFinalResponse: '',
  // disable the final turn entirely:
  // allowFinalResponse: false,
});
```

The pending tool calls from the halted turn are executed first so they
have real outputs in the input, then the full conversation and the
original `instructions` are sent with `toolChoice: 'none'`. Any
non-executable (manual) tool calls in the halted turn are paired with
synthesized stub `function_call_output` items so the input is well-formed.

### Cancellation & Request Timeouts

A `callModel` run is a *sequence* of API requests (initial, one per tool
round, plus final/retry turns). Two independent bounds compose:

```typescript
const controller = new AbortController();

const result = callModel(
  client,
  {
    model: 'openai/gpt-4o',
    input: 'Research this topic',
    tools: [searchTool] as const,
    // Cancel the WHOLE run: stops the loop at the next turn boundary and
    // aborts the in-flight request/stream. Promises reject with the
    // signal's abort reason.
    signal: controller.signal,
  },
  {
    // Bound EACH request: a provider that stalls fails that request after
    // 90s instead of hanging until an outer timeout kills the process.
    timeoutMs: 90000,
  },
);

// later, e.g. on user navigation:
controller.abort(new Error('user cancelled'));
```

`timeoutMs` is per-request (each dispatch gets a fresh budget), not
per-run — bound the run with `stopWhen` (`maxCost`, `maxTokensUsed`,
`stepCountIs`) and/or `signal`. The two compose: when both are set, each
request is bounded by whichever fires first. Prefer the `signal` option
over passing a raw `signal` through `RequestOptions` — the underlying SDK
skips its `timeoutMs` wiring whenever a request already carries a signal,
so the engine re-composes them for you only on the `signal` option path.

### Doom-Loop Detection

Catch runs that stop making progress while continuing to spend: the model
re-issuing the same tool call with identical arguments (including repeated
*empty* calls and repeated invalid-JSON calls), repeating identical
server-tool requests, or emitting the same text tokens over and over. Off by
default; opt in with `doomLoop: true`:

```typescript
const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Research this topic',
  tools: [searchTool, bashTool] as const,
  doomLoop: true, // recommended defaults: observe@2, block@3, stop@6
  // or tune it:
  // doomLoop: {
  //   ladder: { observe: 2, steer: false, block: 3, stop: 6 },
  //   text: { minRepeats: 4 }, // or `false` to disable text detection
  // },
});

// Was the run stopped by detection?
const verdict = await result.getDoomLoopVerdict();
if (verdict) console.warn(verdict.message);
```

Detection is **deterministic** — a verdict is a pure function of the
transcript, so the same sequence of calls/text always fires at the same
point. Identical calls in consecutive **rounds** build a per-tool streak:
interleaved calls to *other* tools don't reset it, and N identical calls
fanned out in parallel within ONE round count once (a streak measures the
model re-issuing a call *after seeing its result*, which requires a round
trip). The streak crosses a graduated ladder — strongest crossed rung wins:

| Action | Effect |
|---|---|
| `observe` | Emit the `DoomLoopDetected` hook only |
| `steer` | Inject a corrective user message before the next turn (off by default). Guidance queued right before a pause persists in `ConversationState.doomLoop.pendingSteer` and is delivered on resume |
| `escalate` | **Recover by throwing more intelligence at the next turn** (off by default; requires an `escalation` config). One-turn overrides — a stronger model and/or a forced `openrouter:advisor` consult — then automatic revert. Bounded by `escalation.maxEscalations` (default 2, persisted across resumes); exhausted or unconfigured escalations fall through to weaker rungs |
| `block` | Refuse the call and return an explanatory error as the tool output — the model sees why and can change course. Not applicable to text or server-tool verdicts (already emitted/executed); those downgrade to `observe` |
| `stop` | Halt the loop before any further model request (`SessionEnd.reason: 'doom_loop'`). Unresolved tool calls in the final turn get synthesized halt-error outputs so persisted history stays well-formed and resumable |

**Escalation recovery** — instead of (or before) blocking, unblock the loop
by escalating the next turn, then return to the cheap model:

```typescript
callModel(client, {
  model: 'z-ai/glm-5.2', // the everyday executor
  input: 'Research this topic',
  tools: [searchTool] as const,
  doomLoop: {
    ladder: { observe: 2, escalate: 3, block: 5, stop: 8 },
    escalation: {
      // Either or both:
      model: 'anthropic/claude-opus-4.6',  // run the NEXT turn on a stronger model
      advisor: true,                        // and/or force an openrouter:advisor consult
      maxEscalations: 2,                    // spend cap for the whole conversation
    },
  },
});
```

On an `escalate` verdict the engine (1) injects a user notice naming the
detected loop, and (2) applies one-turn request overrides: `model` is
swapped for that dispatch only, and/or the `openrouter:advisor` server tool
is appended with `forwardTranscript: true`, loop-diagnosing instructions,
and `toolChoice` pinned to it (`allowed_tools`/`required`) so the stuck
model must consult the advisor before doing anything else. `advisor` may
also be an object passed through as the advisor tool's parameters
(`model`, `instructions`, `maxToolCalls`, ...). The following turn reverts
automatically. Budget is consumed when a recovery is *applied* (not at
verdict time) and `escalationsUsed` persists in `ConversationState.doomLoop`
so a resumed run cannot reset it; concurrent detector verdicts in one window
escalate once.

Ladder configs are sanity-checked at resolve time: enabling `block` with
`stop: false` warns (a model that keeps re-issuing a blocked call loops
until `stopWhen` fires — and `stopWhen` defaults to unbounded), dead
rungs (a weaker threshold at or past an enabled stronger one) warn, and so
does an `escalate` rung without an `escalation` config (or vice versa).

**Tools declare what identifies a call** via `loopKey` on the tool
definition — a **function or a variable**:

```typescript
// Function: compute the identity — a web-search tool normalizes its query.
tool({
  name: 'web_search',
  inputSchema: z.object({ query: z.string() }),
  loopKey: ({ query }) => query.trim().toLowerCase(),
  execute: async ({ query }) => search(query),
});

// Variable (field list): declarative subset — data, not code, so it
// survives serializable tool caches. A bash call is identified by the
// command AND where it runs; other fields (e.g. verbose) don't count.
tool({
  name: 'bash',
  inputSchema: z.object({ command: z.string(), cwd: z.string(), verbose: z.boolean() }),
  loopKey: ['command', 'cwd'],
  execute: async ({ command, cwd }) => run(command, cwd),
});

// Variable (false): statically exempt — repetition is this tool's job.
tool({
  name: 'check_status',
  inputSchema: z.object({ jobId: z.string() }),
  loopKey: false,
  execute: async ({ jobId }) => poll(jobId),
});
```

A function-form `loopKey` may return `null` to exempt an individual call.
Returning `undefined`, throwing, or returning unhashable material (bigint,
circular, >64 levels deep) falls back to the full-arguments identity with a
warning — detection never fails a run. Without any `loopKey`, the full
validated arguments object is the identity. MCP-wrapped tools accept a
`loopKey` via `markMcp(tool, { loopKey })` (prefer the field-list form).

**Fingerprints are a cross-port contract**: key material is canonicalized
per RFC 8785 (JCS) and hashed with SHA-256 over the UTF-8 bytes, so the
Python/Go ports produce identical fingerprints — they MUST use an RFC 8785
implementation (pip `jcs`, `cyberphone/json-canonicalization`), not their
stdlib JSON serializer. The conformance vectors live in
`tests/vectors/doom-loop-fingerprints.json`. Key order never defeats
detection; malformed calls count too (a model stuck emitting the same
invalid JSON trips the detector instead of bouncing off the parse error
forever). Detector state is plain JSON inside `ConversationState.doomLoop`,
so streaks survive serialize → resume **when the resuming call also passes
`doomLoop`**. A `stop` verdict persists across decision-only resumes
(`approveToolCalls`/`rejectToolCalls`); a fresh conversational turn clears
it (streaks are kept, so renewed repetition re-condemns quickly).

The `DoomLoopDetected` hook observes every verdict and can override the
action per event (`overrideAction`, last handler wins) — de-escalate a
block to observe for a known-chatty tool, or escalate straight to stop.

**What this does NOT catch** (documented limits, locked by negative tests):

- **Varying-input loops.** The fingerprint is identity-based: a model that
  invents a fresh nonce/timestamp field each call evades the default
  whole-arguments identity entirely. A `loopKey` that names the meaningful
  fields closes this per tool; the structural fix (outcome hashing — the
  progress-ledger detector from the design doc) is planned, not shipped.
- **Paraphrased repetition.** Text detectors require exact repeated token
  blocks (within a response) or byte-identical whitespace-normalized text
  (across steps). Semantically-identical rephrasings do not trip.
- **Pre-mutation identity.** Fingerprints are computed on the arguments the
  MODEL issued, before any `PreToolUse` mutation — a hook that rewrites
  varying inputs into identical ones does not make them count as repeats
  (and a hook that injects a nonce cannot mask real repetition).
- **Manual/client-executed calls** pause the loop for the caller and are
  not recorded (only executed, blocked, and parse-error calls are
  evidence).

### Tool Approval

Gate tool execution with approval checks for sensitive operations:

```typescript
const deleteTool = tool({
  name: 'delete_record',
  inputSchema: z.object({ id: z.string() }),
  requireApproval: true, // Always require approval
  execute: async ({ id }) => { /* ... */ },
});

// Or use a function for conditional approval
const writeTool = tool({
  name: 'write_file',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  requireApproval: ({ path }) => path.startsWith('/etc'),
  execute: async ({ path, content }) => { /* ... */ },
});

// Handle approvals at the callModel level
const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Delete record abc-123',
  tools: [deleteTool] as const,
  approveToolCalls: async (toolCalls) => {
    // Return IDs of approved tool calls
    return toolCalls.map(tc => tc.id);
  },
});
```

### Lifecycle Hooks

Observe and control the agent loop with typed lifecycle hooks — inspect or
block tool calls, mutate inputs, gate approvals programmatically, intercept
prompts, and run audit/telemetry work. Inspired by the Claude Agent SDK hooks
pattern.

> [!NOTE]
> Lifecycle hooks are distinct from the SDK **transport** hooks
> (`SDKHooks`, `BeforeRequestHook`, `HookContext`, …), which intercept
> HTTP requests. Lifecycle hooks fire on agent-loop events.

**Two usage modes.** Pass a plain object for quick setup, or a `HooksManager`
instance for custom hooks, dynamic registration, and programmatic emit:

```typescript
// Inline config — built-in hooks only
const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Clean up the temp directory',
  tools: [shellTool] as const,
  hooks: {
    PreToolUse: [
      {
        matcher: 'run_shell', // string | RegExp | (toolName) => boolean
        handler: ({ toolName, toolInput }) => {
          if (String(toolInput.command).includes('rm -rf /')) {
            return { block: 'Refusing to run a destructive command' };
          }
        },
      },
    ],
    PostToolUse: [
      { handler: ({ toolName, durationMs }) => console.log(toolName, durationMs) },
    ],
  },
});
```

```typescript
// HooksManager — full control
import { HooksManager } from '@openrouter/agent';

const hooks = new HooksManager();

const unsubscribe = hooks.on('PreToolUse', {
  matcher: /^db_/,
  filter: (payload) => Object.keys(payload.toolInput).length > 0, // optional predicate on the payload
  handler: ({ toolInput }, ctx) => {
    console.log(`[${ctx.sessionId}] intercepting db tool`); // session id lives on the context
    return {
      // Replace the tool's input before execution (mutation piping)
      mutatedInput: { ...toolInput, dryRun: true },
    };
  },
});

const result = callModel(client, { model, input, tools, hooks });

// Later: unsubscribe(), hooks.off(...), hooks.removeAll(...)
```

**Built-in hooks**

| Hook | Fires | Result fields |
|---|---|---|
| `PreToolUse` | Before every client-tool execution (auto, approval-resume, and hook-allowed paths) | `mutatedInput` replaces the tool's arguments; `block: true \| string` skips execution and reports the reason as the tool's error output |
| `PostToolUse` | After a successful tool execution (payload includes `toolOutput`, `durationMs`) | none (void) |
| `PostToolUseFailure` | After a tool execution throws or returns an error. Not fired when a tool never ran (`PermissionRequest` deny, user rejection, `PreToolUse` block) — observe those via the gating hooks themselves | none (void) |
| `UserPromptSubmit` | Before the initial API request, with the user prompt string | `mutatedPrompt` replaces the prompt; `reject: true \| string` aborts the call with an error |
| `PermissionRequest` | When a tool requires approval, before pausing for the human gate | `decision: 'allow'` skips the gate (the tool runs once via the normal round), `'deny'` synthesizes a rejected result without executing, `'ask_user'` (default) falls through to the approval flow. Last handler wins. Payload includes a `riskLevel` derived from the approval gate's shape (`'high'` for tool- or call-level functions, `'medium'` for blanket `true`) |
| `Stop` | When a `stopWhen` condition halts the loop (`reason: 'max_turns'`) | `forceResume: true` continues the loop (capped at 3 consecutive overrides without tool progress — a bare `forceResume` that changes no state will typically re-trigger the stop condition immediately and burn through the cap, so pair it with `appendPrompt` or external state the stop condition observes); `appendPrompt` injects a user message for the next turn (honored independently of `forceResume`). Blocked/rejected tool outputs count as progress for the cap: the model receives that feedback, and each round costs a full request, so the loop cannot spin hot |
| `SessionStart` | Once per run, before the initial request. `config` summarizes the session (`hasTools`, `hasApproval`, `hasState`) | none (void) |
| `SessionEnd` | Once per run, on every exit path — completion, approval pause, interruption, error, and the no-tools streaming paths. `reason` is `'complete' \| 'error' \| 'max_turns' \| 'user' \| 'doom_loop'`. When at least one model call completed, `totalUsage` aggregates tokens/cost across all of them (`modelCalls`, `inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `reasoningTokens`, and `cost` when the server reported it) | none (void) |
| `PostModelCall` | Once per completed model response, on **every** request the loop makes — initial, each tool-round follow-up, the empty-final retry, the `allowFinalResponse` final turn, and approval-resume requests. Payload: `responseId` (the OpenRouter generation id), `model`, `durationMs` (dispatch → fully materialized response, including stream consumption), `turnType` (`'initial' \| 'resume' \| 'tool_round' \| 'final' \| 'retry'`), `turnNumber`, and `usage` (`inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `reasoningTokens`, `cost?`) when the server reported usage accounting. Purely observational — the telemetry primitive for tracing/benchmark consumers: one span per model call | none (void) |
| `DoomLoopDetected` | Every time doom-loop detection crosses a ladder rung, once per `(tool, fingerprint)` per round — parallel duplicates in one round share the event (requires the `doomLoop` option). Payload: `detector` (`'tool-fingerprint' \| 'server-tool-fingerprint' \| 'text-repetition' \| 'text-streak'`), the resolved `action` (`'observe' \| 'steer' \| 'escalate' \| 'block' \| 'stop'`), the `streak`, the `fingerprint`, `toolName`/`toolInput` for tool verdicts, and the explanatory `message` | `overrideAction` replaces the engine's resolved action for this event (last handler wins); `block` on a text or server-tool verdict downgrades to `observe`; `escalate` without an `escalation` config or remaining budget downgrades to `observe` |

Notes on lifecycle pairing: `SessionEnd` only fires when a matching
`SessionStart` succeeded, and at most once per run. Pending async hook work is
always drained on teardown — including on paths that skip `SessionStart`,
such as resuming from a tool approval. A throwing `SessionEnd` handler never
masks the run's original error (teardown failures are logged as warnings).

On no-tools streaming paths the initial response is only materialized when the
stream is consumed, so `PostModelCall` for that response fires during session
teardown (before `SessionEnd`). A stream that fails or errors before producing
a materialized response emits no `PostModelCall`; a `response.incomplete`
response (e.g. truncated at `max_output_tokens`) **does** emit — it carries a
real generation id and consumed tokens. Note `usage.cost` is only present when
the request had usage accounting enabled server-side.
Every handler receives `(payload, context)` — `context` carries the
`sessionId` (the single source of session identity; payloads do not repeat
it), the `hookName`, and an `AbortSignal` for cooperative cancellation. The
engine threads the session id into each emit's context, so a single
`HooksManager` instance can be shared safely across concurrent `callModel`
runs — each run's handlers see that run's id. (If you call `emit()` yourself
on a shared manager, pass `{ sessionId }` in the emit context; the
`setSessionId()` default is a single mutable field and is last-writer-wins.)

**Handler chain semantics**

Handlers for a hook run sequentially in registration order.

- **Matchers** (`matcher`) scope a handler to tool names — exact string,
  `RegExp` (stateful `/g`//`/y` flags are handled safely), or a predicate
  function (truthy/falsy returns are coerced to boolean). Matchers fail
  closed: a matcher-scoped handler is skipped when the emit has no tool name.
- **Filters** (`filter`) are arbitrary predicates on the payload.
- **Mutation piping**: a handler's `mutatedInput`/`mutatedPrompt` replaces the
  corresponding payload field for all subsequent handlers in the chain, and
  for the tool/request itself. A blocking handler's mutation still lands
  before the short-circuit.
- **Short-circuit**: `block`/`reject` with `true` or a non-empty string stops
  the chain (empty strings do not block).
- **Error policy**: by default a throwing handler — or a throwing
  matcher/filter — is logged as a warning and skipped, and the chain
  continues. Construct the manager with
  `new HooksManager(custom, { throwOnHandlerError: true })` to propagate
  errors instead (useful in tests).

**Async fire-and-forget handlers**

A handler can detach background work (telemetry, audit writes) without
blocking the loop by returning an `AsyncOutput` signal:

```typescript
hooks.on('PostToolUse', {
  handler: (payload, ctx) => ({
    async: true,
    work: sendTelemetry(payload, { signal: ctx.signal }),
    asyncTimeout: 5_000, // default 30_000
  }),
});

// On shutdown: abort in-flight handlers, then wait for detached work
hooks.abortInflight('shutdown');
await hooks.drain();
```

`drain()` waits for all detached work, bounded per-handler by `asyncTimeout`.
On timeout the emit's `ctx.signal` is aborted and a warning is logged — the
work itself cannot be forcibly cancelled, so handlers should observe
`ctx.signal` to stop cooperatively. `abortInflight()` reaches detached work
even after the originating `emit()` has returned. The signal object must have
**exactly** the `AsyncOutput` shape (`async: true` plus optional `work`/
`asyncTimeout`); a return value carrying any other field is treated as a
regular result so mutations/blocks are never silently discarded. The
`isAsyncOutput` type guard is exported.

**Custom hooks**

Define your own hooks with Zod schema pairs and full type inference, then emit
them from your own code:

```typescript
import { HooksManager } from '@openrouter/agent';
import { z } from 'zod/v4';

const hooks = new HooksManager({
  DeploymentGate: {
    payload: z.object({ environment: z.string(), version: z.string() }),
    result: z.object({ approved: z.boolean() }),
  },
  AuditLog: {
    payload: z.object({ event: z.string() }),
    result: z.void(), // side-effect only: results are not validated
  },
});

hooks.on('DeploymentGate', {
  handler: ({ environment }) => ({ approved: environment !== 'production' }),
});

const { results } = await hooks.emit('DeploymentGate', {
  environment: 'staging',
  version: '1.2.3',
});
```

Payloads and results are validated against the schemas on every `emit`.
Schemas with `.transform()`, `.default()`, or `.coerce` are honored: handlers
receive the parsed **output** values, matching the inferred TypeScript types.
Custom hook names must be non-empty and must not collide with built-in names.
Custom hooks do not participate in mutation piping or blocking (those are
built-in-only behaviors); the inline config surface only accepts built-in
hooks — unknown names are warned about and skipped.

A payload validation failure follows the same error policy as handlers:
logged and skipped by default, thrown in strict mode.

### Tool Context

Provide typed context data to tools without passing it through the model:

```typescript
const dbTool = tool({
  name: 'query_db',
  inputSchema: z.object({ sql: z.string() }),
  contextSchema: z.object({ connectionString: z.string() }),
  execute: async ({ sql }, ctx) => {
    // Tool context is available on ctx.local
    const db = connect(ctx?.local.connectionString);
    return db.query(sql);
  },
});

const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'List all users',
  tools: [dbTool] as const,
  context: {
    query_db: { connectionString: 'postgres://localhost/mydb' },
  },
});
```

### Shared Context

Share mutable state across all tools in a conversation:

```typescript
const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Process these items',
  tools: [toolA, toolB] as const,
  sharedContextSchema: z.object({ processedIds: z.array(z.string()) }),
  context: {
    shared: { processedIds: [] },
  },
});
```

### Conversation State Management

Persist multi-turn conversations with full state tracking. The `state`
option takes a `StateAccessor` — a `{ load, save }` pair over any storage
backend (memory, SQLite, Redis, …). The loop calls `load` before the run and
`save` as the conversation progresses:

```typescript
import { callModel, type ConversationState, type StateAccessor } from '@openrouter/agent';

// Any storage backend — here, a simple in-memory holder
let stored: ConversationState | null = null;
const state: StateAccessor = {
  load: async () => stored,
  save: async (s) => {
    stored = s;
  },
};

// First turn
const result1 = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Search for TypeScript best practices',
  tools: [searchTool] as const,
  state,
});
await result1.getText();

// Read the updated state (messages, tool calls, status, metadata)
const snapshot = await result1.getState();

// Continue the conversation — the accessor loads the saved history
const result2 = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Now summarize what you found',
  tools: [searchTool] as const,
  state,
});
```

`ConversationState` is plain JSON — `JSON.stringify`/`JSON.parse` it into any
store (this is how serverless/cold-start resume works).

### Dynamic Parameters Between Turns

Adjust model parameters dynamically based on tool execution:

```typescript
const searchTool = tool({
  name: 'search',
  inputSchema: z.object({ query: z.string() }),
  nextTurnParams: {
    temperature: (input) => input.query.includes('creative') ? 0.9 : 0.1,
    maxOutputTokens: () => 2000,
  },
  execute: async ({ query }) => { /* ... */ },
});
```

### Format Compatibility

Convert between OpenRouter and other message formats:

```typescript
import { toClaudeMessage, fromClaudeMessages } from '@openrouter/agent';
import { toChatMessage, fromChatMessages } from '@openrouter/agent';

// Anthropic Claude format
const claudeMsg = toClaudeMessage(openRouterMessage);
const orMessages = fromClaudeMessages(claudeMessages);

// Standard Chat format
const chatMsg = toChatMessage(openRouterMessage);
const orMessages2 = fromChatMessages(chatMessages);
```

## Subpath Exports

For tree-shaking or targeted imports, the package provides granular subpath exports:

```typescript
import { callModel } from '@openrouter/agent/call-model';
import { tool } from '@openrouter/agent/tool';
import { ModelResult } from '@openrouter/agent/model-result';
import { HooksManager } from '@openrouter/agent/hooks-manager';
import { stepCountIs, maxCost } from '@openrouter/agent/stop-conditions';
import { DoomLoopMonitor, fingerprintToolCall } from '@openrouter/agent/doom-loop';
import { toClaudeMessage } from '@openrouter/agent/anthropic-compat';
import { toChatMessage } from '@openrouter/agent/chat-compat';
import { ToolContextStore } from '@openrouter/agent/tool-context';
import { ToolEventBroadcaster } from '@openrouter/agent/tool-event-broadcaster';
import { createInitialState } from '@openrouter/agent/conversation-state';
```

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run unit tests
pnpm test

# Run end-to-end tests (requires OPENROUTER_API_KEY in .env)
pnpm test:e2e

# Type check
pnpm typecheck

# Lint
pnpm lint
```

### Running Tests

Create a `.env` file with your OpenRouter API key:

```env
OPENROUTER_API_KEY=sk-or-...
```

Then run:

```bash
pnpm test        # Unit tests
pnpm test:e2e    # Integration tests (requires API key)
```

## Documentation

Full `callModel` documentation is available at [openrouter.ai/docs/sdks/typescript/call-model](https://openrouter.ai/docs/sdks/typescript/call-model/overview).

## License

Apache-2.0

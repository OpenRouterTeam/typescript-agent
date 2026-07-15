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

When `stopWhen` fires while the model is still emitting tool calls, pass
`allowFinalResponse` to force one more model turn with no tools:

```typescript
callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Research this topic',
  tools: [searchTool] as const,
  stopWhen: stepCountIs(5),
  allowFinalResponse: 'Please summarize what you found.',
  // or just: allowFinalResponse: true
});
```

The pending tool calls from the halted turn are executed first so they
have real outputs in the input, then the full conversation and the
original `instructions` are sent to the model with no tools defined. A
non-empty string value is appended as a final `user` message. Any
non-executable (manual) tool calls in the halted turn are paired with
synthesized stub `function_call_output` items so the input is well-formed.

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
  filter: (payload) => payload.sessionId !== '', // optional predicate on the payload
  handler: ({ toolInput }) => ({
    // Replace the tool's input before execution (mutation piping)
    mutatedInput: { ...toolInput, dryRun: true },
  }),
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
| `SessionEnd` | Once per run, on every exit path — completion, approval pause, interruption, error, and the no-tools streaming paths. `reason` is `'complete' \| 'error' \| 'max_turns' \| 'user'` | none (void) |

Notes on lifecycle pairing: `SessionEnd` only fires when a matching
`SessionStart` succeeded, and at most once per run. Pending async hook work is
always drained on teardown — including on paths that skip `SessionStart`,
such as resuming from a tool approval. A throwing `SessionEnd` handler never
masks the run's original error (teardown failures are logged as warnings).

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

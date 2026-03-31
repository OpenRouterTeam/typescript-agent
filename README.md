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

// Stream tool execution events
for await (const event of result.getToolStream()) {
  console.log(event);
}

// Stream structured tool calls
for await (const toolCall of result.getToolCallsStream()) {
  console.log(toolCall.name, toolCall.input);
}

// Get all tool calls after completion
const toolCalls = await result.getToolCalls();
```

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

### Tool Context

Provide typed context data to tools without passing it through the model:

```typescript
const dbTool = tool({
  name: 'query_db',
  inputSchema: z.object({ sql: z.string() }),
  contextSchema: z.object({ connectionString: z.string() }),
  execute: async ({ sql }, ctx) => {
    const db = connect(ctx?.context.connectionString);
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

Persist multi-turn conversations with full state tracking:

```typescript
import { createInitialState, callModel } from '@openrouter/agent';

// Start a conversation
let state = createInitialState();

// First turn
const result1 = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Search for TypeScript best practices',
  tools: [searchTool] as const,
  state,
});

// State is updated with messages, tool calls, and metadata
state = (await result1.getResponse()).state;

// Continue the conversation
const result2 = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Now summarize what you found',
  tools: [searchTool] as const,
  state,
});
```

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

Full documentation is available at [openrouter.ai/docs](https://openrouter.ai/docs).

## License

Apache-2.0

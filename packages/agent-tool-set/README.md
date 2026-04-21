# @openrouter/agent-tool-set

Declarative, state-aware activation and deactivation for tools used with `@openrouter/agent`.

Port of [`ai-tool-set`](https://github.com/zirkelc/ai-tool-set) v1.0.0 (MIT © zirkelc), adapted for this SDK:

- Input is an ordered array of `Tool` (as used by `callModel`), not a name-keyed record.
- Predicates receive `{ state, context }` where `state` is the SDK's `ConversationState` and `context` is the typed shared context.
- Integrates with a new `activeTools` option on `callModel` — you can spread `inferTools()` directly into the request.

## Install

```bash
pnpm add @openrouter/agent-tool-set
```

## Usage

```ts
import { OpenRouter, tool, callModel } from '@openrouter/agent';
import { createToolSet } from '@openrouter/agent-tool-set';
import { z } from 'zod/v4';

type AppContext = {
  isAuthenticated: boolean;
};

const listOrders = tool({
  name: 'list_orders',
  inputSchema: z.object({}),
  execute: async () => ({ orders: [] }),
});

const cancelOrder = tool({
  name: 'cancel_order',
  inputSchema: z.object({ id: z.string() }),
  execute: async () => ({ ok: true }),
});

const allTools = [listOrders, cancelOrder] as const;

const toolSet = createToolSet<typeof allTools, AppContext>({ tools: allTools })
  .activateWhen('list_orders', ({ context }) => context?.isAuthenticated === true)
  .deactivateWhen('cancel_order', ({ state }) => (state?.messages?.length ?? 0) === 0);

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const { tools, activeTools } = toolSet.inferTools({ context: { isAuthenticated: true } });

const result = callModel(client, {
  model: 'openai/gpt-4o-mini',
  input: 'List my orders.',
  tools,
  activeTools,
});
```

## API

- `createToolSet<T, TShared?>({ tools, mutable? })` — build a set from an ordered tool array. Optional `TShared` generic types the `context` argument passed to predicates.
- `.tools` — all tools in construction order, regardless of activation. Includes both client tools and server tools.
- `.activate(name | names[])` / `.deactivate(name | names[])` — static flip (client tools only).
- `.activateWhen(name, predicate)` / `.activateWhen({ [name]: predicate, ... })` — conditional activation (defaults inactive).
- `.deactivateWhen(name, predicate)` / `.deactivateWhen({ [name]: predicate, ... })` — conditional deactivation (defaults active).
- `.inferTools(input?)` → `{ tools: Tool[]; activeTools: string[] }` — resolve against an input. Server tools (which have no `function.name`) are always included in `tools` and never appear in `activeTools`; only client tools participate in activation.
- `.clone({ mutable? })` — copy state, optionally flipping mode.

Last-call-wins: each directive on a given tool replaces any prior one for that tool.

Immutable by default (every mutator returns a new `ToolSet`). Pass `mutable: true` to mutate in place.

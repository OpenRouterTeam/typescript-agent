---
"@openrouter/agent-tool-set": minor
"@openrouter/agent": minor
---

Add `@openrouter/agent-tool-set` (port of ai-tool-set v1.0.0, MIT © Chris Cook): declarative activate / deactivate / activateWhen / deactivateWhen for tools with state- and context-aware predicates. Integrates with a new `activeTools?: readonly string[]` option on `callModel` that filters which tools are sent to the model for a given call.

```ts
import { callModel, OpenRouter, serverTool, tool } from '@openrouter/agent';
import { createToolSet } from '@openrouter/agent-tool-set';
import { z } from 'zod/v4';

const listOrders = tool({
  name: 'list_orders',
  inputSchema: z.object({}),
  execute: async () => ({ orders: [] }),
});
// override the default `server:${type}` id
const search = serverTool({ type: 'web_search_2025_08_26' }, { id: 'public_search' });

const toolSet = createToolSet({ tools: [listOrders, search] as const }).deactivate(
  'list_orders',
);

const client = new OpenRouter({ apiKey: process.env['OPENROUTER_API_KEY'] });
const resolved = toolSet.resolve();

// resolved.callModel is `{ tools, activeTools }` — spread it straight in
const result = callModel(client, {
  model: 'openai/gpt-4o-mini',
  input: 'Search for OpenRouter pricing.',
  ...resolved.callModel,
});
```

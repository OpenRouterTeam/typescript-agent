---
"@openrouter/agent": minor
---

Add `toolChoice` to `nextTurnParams`, so a tool can change which tools the model may call on the following turn without touching the `tools` array.

This is what a tool-search tool needs: declare every tool up front, keep the not-yet-needed ones out of reach behind an `allowed_tools` choice, and widen that choice as the model discovers what it wants. Because `tools` is byte-identical across turns, the provider's prompt-cache prefix survives — which is the whole reason to withhold tools rather than send them all.

```ts
import { callModel, OpenRouter, tool } from '@openrouter/agent';
import { z } from 'zod/v4';

const allowed = (names: string[]) => ({
  type: 'allowed_tools' as const,
  mode: 'auto' as const,
  tools: names.map((name) => ({ type: 'function', name })),
});

const toolSearch = tool({
  name: 'tool_search',
  inputSchema: z.object({ pattern: z.string() }),
  execute: ({ pattern }) => findMatchingToolNames(pattern),
  nextTurnParams: {
    // Append, never rebuild: dropping a name revokes a tool the model may
    // already have used, and reordering churns the request for nothing.
    toolChoice: ({ pattern }, context) =>
      allowed([...namesIn(context.toolChoice), ...findMatchingToolNames(pattern)]),
  },
});

const client = new OpenRouter({ apiKey: process.env['OPENROUTER_API_KEY'] });

const result = callModel(client, {
  model: 'openai/gpt-4o-mini',
  input: 'What is the weather in Tokyo?',
  tools: [toolSearch, getWeather, sendEmail, listRepos],
  // Only the search tool is reachable until it finds something.
  toolChoice: allowed(['tool_search']),
});
```

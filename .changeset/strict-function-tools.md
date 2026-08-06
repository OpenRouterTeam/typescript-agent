---
'@openrouter/agent': minor
---

Add `strict` to all client function-tool definitions, including `tool.agent()`, and pass it through serialization instead of hardcoding `strict: null`, so providers can enforce structured-outputs-style schema adherence on tool-call arguments.

When `strict: true`, the SDK now validates the generated schema before dispatch. OpenAI-style strict schemas require every object property to be listed in `required`; use Zod `.nullable()` for conceptually optional values because `.optional()` changes the runtime contract by allowing the key to be omitted.

```ts
import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';

const searchTool = tool({
  name: 'search',
  inputSchema: z.object({ query: z.string() }),
  strict: true, // was: silently dropped (serialized as strict: null)
  // now: serialized as strict: true on the wire tool definition
  execute: async ({ query }) => runSearch(query),
});
```

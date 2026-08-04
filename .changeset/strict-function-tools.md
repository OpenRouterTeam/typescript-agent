---
'@openrouter/agent': minor
---

Add `strict` to `tool()` function-tool definitions and pass it through serialization instead of hardcoding `strict: null`, so providers can enforce structured-outputs-style schema adherence on tool-call arguments.

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

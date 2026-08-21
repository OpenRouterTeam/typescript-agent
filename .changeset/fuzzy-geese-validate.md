---
'@openrouter/agent': minor
---

Add Standard Schema v1 support for tool input, output, event, context, shared context, check, and custom hook schemas while preserving the existing Zod v4 fast path.

```ts
import { tool } from '@openrouter/agent';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

// Trait path: toStandardJsonSchema exposes StandardJSONSchemaV1, so no
// inputJsonSchema is needed.
const search = tool({
  name: 'search',
  inputSchema: toStandardJsonSchema(v.object({ query: v.string() })),
  outputSchema: v.object({ results: v.array(v.string()) }),
  execute: async ({ query }) => ({ results: await searchWeb(query) }),
});

// Escape hatch: validation-only Standard Schema inputs supply the
// provider-facing JSON Schema explicitly (always wins when present).
const lookup = tool({
  name: 'lookup',
  inputSchema: v.object({ id: v.pipe(v.string(), v.transform(Number)) }),
  inputJsonSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  execute: async ({ id }) => db.get(id), // id is the transformed number
});
```

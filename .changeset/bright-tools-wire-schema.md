---
'@openrouter/agent': minor
---

Allow manual tools to provide a caller-owned JSON Schema for wire serialization.

```ts
import { tool } from '@openrouter/agent';
import { z } from 'zod';

const confirmTool = tool({
  name: 'confirm_action',
  inputSchema: z.object({ action: z.string() }),
  wireInputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
    },
    required: ['action'],
  },
  execute: false,
});
```

---
'@openrouter/agent': minor
---

Add opt-in replay compaction and terminal response-event handling for streamed model calls.

```ts
import { callModel } from '@openrouter/agent';

const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Summarize this document.',
  // Retain only the history needed by currently attached consumers.
  streamReplay: 'active-consumers',
});
```

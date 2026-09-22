---
'@openrouter/agent': patch
---

Do not execute tool calls from a response truncated at `max_output_tokens`. A turn that hits the token budget mid-tool-call now finalizes with `status: 'incomplete'` instead of running the cut-off call (and re-requesting on the same exhausted budget).

```ts
import { callModel } from '@openrouter/agent';

const result = callModel(client, {
  model: 'anthropic/claude-sonnet-4.5',
  maxOutputTokens: 512, // budget exhausted mid tool call
  tools: [myTool],
});
const response = await result.getResponse();
// response.status === 'incomplete'
// response.incompleteDetails.reason === 'max_output_tokens'
// The cut-off call is NOT executed; raise the budget and re-request.
```

---
'@openrouter/agent': minor
---

Add a `stream` option to `callModel`. It defaults to `true`, which keeps today's behavior. `stream: false` sends every model request in the run as non-streaming: initial, tool-round follow-ups, the final turn, the empty-final retry, and approval resumes. Each of those sites previously hardcoded `stream: true`.

A non-streaming request gets a provider error such as an overload back before OpenRouter has committed a response, so provider failover and `models` fallback still apply. With streaming, the same error arrives mid-stream as `response.failed` and fails the run.

```ts
import { callModel } from '@openrouter/agent';

const result = callModel(client, {
  model: 'anthropic/claude-sonnet-4.5',
  models: ['openai/gpt-5-mini'],
  input: 'Find the relevant pages',
  tools: [searchTool],
  stream: false,
});
const text = await result.getText();
```

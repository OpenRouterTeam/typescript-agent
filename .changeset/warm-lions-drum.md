---
'@openrouter/agent': patch
---

Relax an unchanged forced `toolChoice` (`required`, a specific tool, or `allowed_tools` with `mode: 'required'`) to `auto` after it produces a tool call, including follow-ups resumed after approval, HITL, client-tool, or async-tool pauses. Dynamically resolved choices re-arm when their semantic value changes. This lets the model synthesize a final text answer instead of being forced to call tools until the step budget runs out (DEV-785).

```ts
const result = callModel(client, {
  model: 'openai/gpt-4o',
  input: 'Plan, research, then submit.',
  tools: [planTool, searchTool, submitTool] as const,
  toolChoice: ({ numberOfTurns }) =>
    numberOfTurns === 0
      ? { type: 'function', name: 'plan' }
      : numberOfTurns === 3
        ? { type: 'function', name: 'submit' }
        : 'auto',
});
```

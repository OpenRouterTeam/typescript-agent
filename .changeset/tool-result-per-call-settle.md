---
'@openrouter/agent': patch
---

Broadcast each tool call's `tool.result` / `tool.call_output` (and the legacy `tool_result`) the moment that call settles, instead of holding every broadcast until the whole round's `Promise.allSettled` resolves. With serially executing calls (e.g. `maxConcurrency: 1`), stream consumers now see each call complete live rather than all at once when the round ends. Model-facing `function_call_output` assembly is unchanged: outputs are still collected in call order, so follow-up request input and prompt-cache behavior are identical. (DEV-1067)

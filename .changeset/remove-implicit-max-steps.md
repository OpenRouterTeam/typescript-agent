---
"@openrouter/agent": minor
---

Remove implicit 5-step cap in `callModel`. When `stopWhen` is omitted, the tool-execution loop now runs until the model produces a turn with no tool calls instead of stopping at 5 steps. Pass an explicit `stopWhen` (e.g. `stepCountIs(n)`, `maxCost(...)`, `maxTokensUsed(...)`) to bound iterations.

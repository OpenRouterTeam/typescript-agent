---
"@openrouter/agent": patch
---

`toModelOutput` now receives the tool input after `inputSchema` parsing (the same value `execute` gets), and it now runs for results produced on the approval-resume path, so approved tool calls send the model the mapped output instead of the raw `execute` result.

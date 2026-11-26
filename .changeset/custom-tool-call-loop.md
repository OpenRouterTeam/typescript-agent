---
"@openrouter/agent": patch
---

`callModel` now stops on `custom_tool_call` items instead of continuing past them. Pass a custom (freeform-grammar) tool as `serverTool({ type: 'custom', name, format })`; it reaches the model as a native `custom` tool with its grammar. Custom tools are always executed by the caller, so when the model calls one, the loop runs any auto-executed function calls from the same turn, then returns the response with the `custom_tool_call` for the caller to run. Previously a turn with an auto-executed function call and a custom call sent a follow-up request with the custom call unpaired, and `custom_tool_call` items were counted as server-tool results.

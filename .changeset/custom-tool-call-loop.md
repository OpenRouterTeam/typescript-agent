---
"@openrouter/agent": patch
---

Add `customTool({ name, description, format })` for caller-executed custom (freeform-grammar) tools. The tool reaches the model as a native Responses `custom` tool with its grammar unchanged. `custom_tool_call` items are now parsed tool calls with `kind: 'custom'` and the raw `input` string as `arguments`; they never auto-execute. When the model calls one, the loop runs any auto-executed function calls from the same turn, then stops with the custom call unresolved: it is returned by `getPendingToolCalls()` and, with a state accessor, saved with status `awaiting_client_tools`. Resume by passing a `custom_tool_call_output` for the pending call. Previously a turn with an auto-executed function call and a custom call sent a follow-up request with the custom call unpaired, custom-only turns were not saved as a pause, and `custom_tool_call` items were counted as server-tool results. `ServerToolConfig` no longer accepts `type: 'custom'`.

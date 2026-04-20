---
"@openrouter/agent": minor
---

Add `serverTool()` factory for OpenRouter's server-executed tools (web search, `openrouter:datetime`, image generation, MCP, file search, code interpreter, and future SDK additions). Server tools can be mixed with client `tool()`s in the `callModel({ tools })` array; OpenRouter runs them and their output items flow through the unified `ModelResult.allToolExecutionRounds[].toolResults` list.

- `getItemsStream()` yields server-tool output items (e.g. `web_search_call`, `openrouter:datetime`) alongside client `function_call` / `function_call_output` items. The yielded union is narrowed from the `TTools` passed to `callModel`, so consumers only see item types that are reachable for their tool set.
- `StepResult.serverToolResults` exposes provider-side tool invocations to `stopWhen` conditions (the existing `toolResults` field remains client-tool-only).
- New public exports: `serverTool`, `isServerTool`, `isClientTool`, and the types `ServerTool`, `ServerToolConfig`, `ServerToolType`, `ServerToolResultItem`, `ClientTool`, `ToolResultItem`.

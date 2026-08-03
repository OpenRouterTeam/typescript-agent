---
'@openrouter/agent': patch
---

Thread the executed tool call into the hook execute context. `context.toolCall` is part of the tool-facing contract, but only the non-streaming orchestrator populated it — the streaming `ModelResult` loop builds its turn context with just `numberOfTurns`, so `execute` / `onToolCalled` hooks saw `toolCall: undefined` on the streaming path. `buildExecuteCtx` now fills the gap from the executed call: a caller-provided `turnContext.toolCall` still wins (the orchestrator's carries `status`), and otherwise the executed `ParsedToolCall` is converted back to a wire-shaped `FunctionCallItem`. The `onResponseReceived` path intentionally threads nothing — only the `function_call_output` item is in scope there.

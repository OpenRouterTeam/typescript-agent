---
"@openrouter/agent": patch
---

Send a string `function_call_output` when a tool's `execute` returns nothing. `JSON.stringify(undefined)` is `undefined`, so a tool such as `async () => { log() }` made the follow-up request fail SDK validation (`SDKValidationError: Input validation failed`) after the tool had already run. Tool results now serialize through one helper that falls back to `"null"`.

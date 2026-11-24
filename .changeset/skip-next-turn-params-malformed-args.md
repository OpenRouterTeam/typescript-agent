---
'@openrouter/agent': patch
---

Skip a tool's `nextTurnParams` hooks for a call whose arguments are not an object.

When a model emits truncated JSON, the tool call keeps its arguments as a raw string. `executeNextTurnParamsFunctions` threw `Tool call arguments for <name> must be an object` for that call, and the error aborted the whole `callModel` run after the tool's execute path had already returned a structured error to the model. The hooks are now skipped for that call, the request parameters stay as they were, and the loop sends the follow-up request. Calls with object arguments run their hooks as before.

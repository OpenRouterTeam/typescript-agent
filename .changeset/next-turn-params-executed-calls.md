---
'@openrouter/agent': patch
---

Run a tool's `nextTurnParams` only for calls whose tool body ran and returned without error.

Previously `nextTurnParams` ran for every function call in the model response, with the call's raw arguments. A call blocked by a `PreToolUse` hook or a `PermissionRequest` denial, a call whose arguments failed `inputSchema`, a call that timed out, and a call whose `execute` threw could still change the next request, for example widening `toolChoice: { type: 'allowed_tools' }` to a tool the application meant to keep out of reach. Those calls now leave the request parameters unchanged, and `nextTurnParams` receives the input the tool actually ran on, including any `PreToolUse` `mutatedInput`.

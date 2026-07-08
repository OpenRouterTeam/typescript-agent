---
'@openrouter/agent': patch
---

Stop the tool-execution loop when a round contains unresolved manual (client-executed) tool calls, instead of sending a follow-up request whose input carries a `function_call` with no matching `function_call_output` — a history providers reject with a 400 "No tool output found for function call ...". The response is surfaced so the caller can execute the manual calls and continue, mirroring the existing all-manual behavior.

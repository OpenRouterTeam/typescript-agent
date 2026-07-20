---
"@openrouter/agent": patch
---

Tolerate empty final `output` after completed tool rounds: retry the follow-up request once, then resolve successfully with empty text instead of throwing `Invalid final response: empty or invalid output`. Mini-class models intermittently treat a successful tool call as the terminal answer. Opt into the old throw with `strictFinalResponse: true`. Runs with no completed tool work still throw on empty output.

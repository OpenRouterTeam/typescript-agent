---
"@openrouter/agent": patch
---

Security hardening: when `stopWhen` is already met on the first response and `allowFinalResponse` is `false`, pausing for an approval-gated tool call no longer executes its auto-approved sibling calls. They are saved as skipped results instead.

---
"@openrouter/agent": patch
---

Run the approval check before executing pending tool calls on the `allowFinalResponse` path, and evaluate function-form `requireApproval` predicates against schema-normalized arguments so the approval decision matches the executed input.

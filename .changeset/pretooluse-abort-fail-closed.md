---
"@openrouter/agent": patch
---

Fail closed when a blocking hook chain is aborted. If a `PreToolUse` or `UserPromptSubmit` chain stops early because its signal was aborted (an `asyncTimeout` on detached work expiring, or `abortInflight()`), the emit result now reports `blocked: true` instead of `blocked: false`, so handlers that never ran (for example a later deny guard) can no longer be skipped into an approval.

---
'@openrouter/agent': patch
---

Relax a forced `toolChoice` (`required`, a specific tool, or `allowed_tools` with `mode: 'required'`) to `auto` on follow-up turns after a tool round has executed, so the model can synthesize a final text answer instead of being forced to call tools until the step budget runs out (DEV-785).

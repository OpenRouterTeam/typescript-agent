---
'@openrouter/agent': patch
---

Reduce multi-turn streaming memory by sharing initial response materialization with full-stream consumers, avoiding redundant follow-up replay buffers, and releasing completed transport references while preserving replay behavior.

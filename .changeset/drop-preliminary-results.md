---
'@openrouter/agent': major
---

Stop accumulating generator-tool `preliminaryResults` arrays. Yields are still broadcast live; the terminal `tool.result` event and `ToolExecutionResult` no longer carry the full yield history.

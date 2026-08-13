---
'@openrouter/agent': patch
---

Stop accumulating generator-tool `preliminaryResults` arrays. Yields are still broadcast live; the terminal `tool.result` event no longer copies every yield.

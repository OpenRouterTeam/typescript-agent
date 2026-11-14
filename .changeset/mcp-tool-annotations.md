---
"@openrouter/agent": minor
---

MCP tools now keep the `annotations` their server reports in `tools/list` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`). Read them from `tool.annotations` on a tool returned by `createMCPTools` or `rehydrateMCPTools`; cache snapshots store and restore them. The field is absent when the server sent none.

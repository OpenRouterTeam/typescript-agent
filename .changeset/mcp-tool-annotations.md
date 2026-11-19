---
"@openrouter/agent": minor
---

MCP tools now keep the `annotations` their server reports in `tools/list` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`). Read them from `tool.annotations` on a tool returned by `createMCPTools` or `rehydrateMCPTools`; cache snapshots store and restore them in the new `SerializedMCPToolDef.annotations` field. The field is absent when the server sent none, and any other key is dropped. `McpToolAnnotations` is exported from the package root.

```ts
import { isMcpTool, type McpToolAnnotations } from '@openrouter/agent';
import { createMCPTools } from '@openrouter/agent/mcp';

const handle = await createMCPTools({ url: 'https://mcp.example.com/mcp' });

// new: `tool.annotations` holds the server's hints; absent when it sent none.
// An absent hint has the MCP default, which is `true` for `destructiveHint`
// and `openWorldHint`, so compare against the default, not `=== true`.
const mayDestroy = (hints: McpToolAnnotations | undefined): boolean =>
  hints?.readOnlyHint !== true && hints?.destructiveHint !== false;

const needApproval = handle.tools.filter(
  (tool) => isMcpTool(tool) && mayDestroy(tool.annotations),
);

// new: a snapshot stores the hints as `tools[].annotations` and restores them.
const snapshot = await handle.serialize();
```

A snapshot written by an earlier version has no annotations, so tools rebuilt from it have none until the server is listed again (`handle.refresh()`, or a `staleness.maxAgeMs` that has passed).

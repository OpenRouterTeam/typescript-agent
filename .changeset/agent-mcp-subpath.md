---
"@openrouter/agent": minor
"@openrouter/mcp": minor
---

Add the full MCP integration under the canonical `@openrouter/agent/mcp` subpath. `@modelcontextprotocol/sdk` is an optional peer, so base agent installations and imports do not install or load MCP support. The existing `@openrouter/mcp` package remains as a compatibility facade and now re-exports the canonical agent subpaths.

```ts
import { callModel, OpenRouter } from '@openrouter/agent';
import { createMCPTools } from '@openrouter/agent/mcp';

const mcp = await createMCPTools({ url: 'https://mcp.example.com/mcp' });
const result = callModel(new OpenRouter(), {
  model: 'openai/gpt-4o-mini',
  input: 'Use the remote tools.',
  tools: mcp.tools,
});
```

Install `@modelcontextprotocol/sdk` alongside `@openrouter/agent` when using `/mcp`. The SDK is loaded lazily, so importing the base agent or the MCP entry point does not require the peer; the first MCP connection attempt without it throws an actionable `MCPMissingPeerDependencyError`.

Existing `@openrouter/mcp` imports continue to work as tooling-visible deprecated migration facades, but new code should prefer `@openrouter/agent/mcp`. The facade would only be removed in a future breaking release after migration notice.

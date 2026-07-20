---
"@openrouter/mcp": minor
---

Add `@openrouter/mcp`: expose remote MCP server tools (Streamable HTTP / SSE) as `callModel` tools.

- `createMCPTools()` connects to a non-stdio MCP server, authenticates once (bearer token, custom headers, or a pluggable `OAuthClientProvider`), and returns a handle whose `.tools` drop straight into `callModel({ tools })`. The same auth is reused for tool discovery and every tool call.
- Faithful runtime JSON-Schema → Zod v4 conversion (`convertMcpInputSchema`) so the model sees real parameters; tool output schemas are mapped too.
- Serializable, rehydratable cache (`serialize()` / `rehydrateMCPTools()` / pluggable `MCPCacheStore` + `InMemoryMCPCacheStore`) that skips re-listing and, opt-in, re-authentication. Credential caching is off by default.
- MCP feature support: progress notifications surfaced as generator-tool events, `tools/list_changed` auto-refresh, cancellation via an abort signal, resources exposed as synthetic `list_resources`/`read_resource` tools, and elicitation with an optional handler (auto-declines when none is provided).

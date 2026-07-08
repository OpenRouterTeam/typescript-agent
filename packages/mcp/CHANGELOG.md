# @openrouter/mcp

## 0.2.0

### Minor Changes

- [#56](https://github.com/OpenRouterTeam/typescript-agent/pull/56) [`209499a`](https://github.com/OpenRouterTeam/typescript-agent/commit/209499abacd6783ee5c98155bb2a676e3932c3f4) Thanks [@mattapperson](https://github.com/mattapperson)! - Add a `source` discriminant to tool results so untyped MCP tools no longer collapse the type safety of typed tools.

  Previously, mixing an MCP tool (whose output schema is `unknown`) with fully-typed tools in one `callModel({ tools })` array collapsed the entire result union to `unknown` — one untyped tool poisoned every other tool's result type.

  - `ToolExecutionResult` (and `ToolExecutionResultUnion`) now carry `source: 'client' | 'mcp'`. Narrowing on `source === 'client'` recovers the precise, schema-derived results for your own tools; MCP results stay isolated as `unknown` under `source === 'mcp'`.
  - `ToolResultEvent` (streaming: `getFullResponsesStream`, `getToolStream`) gains the same `source` field. **Breaking:** the `tool.result` event payload now includes `source`; consumers that constructed or exhaustively matched these events may need to account for it.
  - `@openrouter/agent` exports a `markMcp()` helper, an `isMcpTool()` guard, and the `McpBranded` type. `@openrouter/mcp` brands every wrapped tool (including synthetic `list_resources`/`read_resource`) so the discrimination is automatic — callers just spread `mcp.tools` as before.
  - MCP tools continue to execute locally and serialize to the wire as `type: 'function'`; the brand is purely informational and does not change runtime behavior.

- [#56](https://github.com/OpenRouterTeam/typescript-agent/pull/56) [`26336b5`](https://github.com/OpenRouterTeam/typescript-agent/commit/26336b5c44e5591b380ca4c41bf93b05f0ccdfe2) Thanks [@mattapperson](https://github.com/mattapperson)! - Add `@openrouter/mcp`: expose remote MCP server tools (Streamable HTTP / SSE) as `callModel` tools.

  - `createMCPTools()` connects to a non-stdio MCP server, authenticates once (bearer token, custom headers, or a pluggable `OAuthClientProvider`), and returns a handle whose `.tools` drop straight into `callModel({ tools })`. The same auth is reused for tool discovery and every tool call.
  - Faithful runtime JSON-Schema → Zod v4 conversion (`convertMcpInputSchema`) so the model sees real parameters; tool output schemas are mapped too.
  - Serializable, rehydratable cache (`serialize()` / `rehydrateMCPTools()` / pluggable `MCPCacheStore` + `InMemoryMCPCacheStore`) that skips re-listing and, opt-in, re-authentication. Credential caching is off by default.
  - MCP feature support: progress notifications surfaced as generator-tool events, `tools/list_changed` auto-refresh, cancellation via an abort signal, resources exposed as synthetic `list_resources`/`read_resource` tools, and elicitation with an optional handler (auto-declines when none is provided).

### Patch Changes

- Updated dependencies [[`209499a`](https://github.com/OpenRouterTeam/typescript-agent/commit/209499abacd6783ee5c98155bb2a676e3932c3f4), [`8edae63`](https://github.com/OpenRouterTeam/typescript-agent/commit/8edae63f4f6fe89e146f3abbf6d24dab7a164681)]:
  - @openrouter/agent@0.8.0

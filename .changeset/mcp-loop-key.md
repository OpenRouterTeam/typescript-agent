---
'@openrouter/mcp': minor
---

Doom-loop `loopKey` support for MCP-wrapped tools (pairs with `@openrouter/agent`'s `doomLoop` option).

Two ways to declare a wrapped tool's call identity: a client-side `loopKeys` map on `createMCPTools`/`rehydrateMCPTools` (keyed by unprefixed MCP tool name; any `ToolLoopKey` form — function, field-name array, or `false` to exempt), and a server-advertised `_meta['openrouter/loopKey']` on the tool definition (data-only: field-name array or `false`). Client config takes precedence. Server-advertised declarations ride the cache snapshot (`SerializedMCPToolDef.loopKey`), so rehydrated tool sets keep their identities without a `listTools()` round-trip; function forms are client-side only and cannot be cached.

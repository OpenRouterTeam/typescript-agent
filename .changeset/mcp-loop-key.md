---
'@openrouter/mcp': minor
---

Doom-loop `loopKey` support for MCP-wrapped tools (pairs with `@openrouter/agent`'s `doomLoop` option).

Two ways to declare a wrapped tool's call identity: a client-side `loopKeys` map on `createMCPTools`/`rehydrateMCPTools` (keyed by unprefixed MCP tool name; any `ToolLoopKey` form — function, field-name array, or `false` to exempt), and a server-advertised `_meta['openrouter/loopKey']` on the tool definition (data-only: field-name array or `false`). Client config takes precedence. Server-advertised declarations ride the cache snapshot (`SerializedMCPToolDef.loopKey`), so rehydrated tool sets keep their identities without a `listTools()` round-trip; function forms are client-side only and cannot be cached.

```ts
import { createMCPTools } from '@openrouter/agent/mcp';

const mcp = await createMCPTools({
  url: 'https://mcp.example.com/mcp',
  // Keyed by the UNPREFIXED MCP tool name, even when toolNamePrefix is set.
  // Any ToolLoopKey form: a field-name array, `false` to exempt, or a
  // function computing key material (client-side only — not cacheable).
  loopKeys: {
    run_command: ['command', 'cwd'],
    poll_job: false,
  },
  cache: { store },
});

const result = client.callModel({
  model: 'z-ai/glm-5.2',
  input: 'Get the build passing.',
  tools: mcp.tools,
  doomLoop: true,
});
```

A server can advertise the same thing itself via
`_meta['openrouter/loopKey']` on the tool definition (data-only: a field-name
array or `false`). Client `loopKeys` win over a server declaration, and
server-advertised values survive a cache round-trip via
`SerializedMCPToolDef.loopKey`.

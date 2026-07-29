---
'@openrouter/mcp': minor
---

Support both MCP protocol revisions. Any server now works out of the box, whether it
speaks `2025-11-25` or `2026-07-28`.

Migrates from `@modelcontextprotocol/sdk@^1.29.0` to `@modelcontextprotocol/client@^2.0.0`
and adds `protocolNegotiation?: 'legacy' | 'auto' | { pin: string }`, defaulting to
`'auto'`. Under `'auto'` the client probes with `server/discover` and then speaks whichever
revision the server offers — the per-request `_meta` envelope for `2026-07-28`, or the
classic `initialize` handshake for `2025-11-25` and earlier.

**Breaking:** if you pass `auth: { kind: 'oauth', provider }`, your provider must satisfy
`@modelcontextprotocol/client@2.0.0`'s `OAuthClientProvider` — change the import specifier,
and note `tokens()` now returns `StoredOAuthTokens` (same fields, so most providers compile
unchanged). Type it with the newly exported `MCPOAuthClientProvider` to avoid depending on
that path again.

**Breaking:** `protocolNegotiation` defaults to `'auto'`, where the SDK defaults to
`'legacy'`. Every connection's first request therefore becomes a `server/discover` probe. A
server that hangs or 5xx's on an unknown method — proxies, WAFs, strict gateways — goes from
working to failing on this upgrade, because a probe timeout over HTTP is treated as an
outage and rejects, and the SSE fallback re-probes and fails the same way. Pass
`protocolNegotiation: 'legacy'` to keep the previous behavior exactly.

```ts
import { createMCPTools, type MCPOAuthClientProvider } from '@openrouter/mcp';

// Default: probes with `server/discover`, then speaks whichever revision the
// server offers. New behavior — see the Breaking note above.
const mcp = await createMCPTools({ url: 'https://mcp.example.com/mcp' });

// Opt out: classic `initialize` handshake only, matching pre-upgrade behavior.
// Use this if your server sits behind a gateway that rejects unknown methods.
const legacy = await createMCPTools({
  url: 'https://mcp.example.com/mcp',
  protocolNegotiation: 'legacy',
});

// Or pin one revision explicitly.
const pinned = await createMCPTools({
  url: 'https://mcp.example.com/mcp',
  protocolNegotiation: { pin: '2026-07-28' },
});

// OAuth providers: type against the new export rather than the SDK path.
const provider: MCPOAuthClientProvider = myProvider;
await createMCPTools({
  url: 'https://mcp.example.com/mcp',
  auth: { kind: 'oauth', provider },
});
```

Also in this release:

- Fixes a silent bug in the `callTool` bridge: SDK v2 dropped the middle argument, so the
  old call shape would have put `signal` and `onprogress` in an unread slot, disabling
  cancellation and progress streaming.
- Corrects the self-reported `clientInfo` version, which said `0.1.0` while the package was
  `0.0.1`, and now generates it from `package.json` so it cannot drift.
- `staleness.maxAgeMs` is now honoured by `rehydrateMCPTools()` too, not just by
  `createMCPTools()`'s cache-hit path — a direct rehydrate previously replayed snapshots of
  any age.
- `onElicitation` is no longer deprecated: it works on both revisions, since the
  multi-round-trip driver routes `input_required` through the same handler.
- New test coverage for both protocol eras over `InMemoryTransport`, and for the
  Streamable HTTP → SSE fallback.

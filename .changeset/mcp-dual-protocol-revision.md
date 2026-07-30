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
  any age. This holds under `reconnectOnExpiry: false` as well: a stale snapshot re-lists
  over the replayed connection rather than being served as-is, since "stale" means the tool
  set needs re-reading, not that the transport needs rebuilding. If that re-list fails, the
  call rejects with the new `MCPStaleSnapshotError` rather than quietly serving tools the
  caller declared too old — catch it specifically to opt into stale-but-usable tools. It
  subclasses `MCPCacheError`, so existing catch sites are unaffected.
- `onElicitation` is no longer deprecated: it works on both revisions, since the
  multi-round-trip driver routes `input_required` through the same handler.
- `handle.refresh()` genuinely re-reads the tool list again. SDK v2 added a per-client
  response cache honouring the server's `ttlMs` on `tools/list` (up to 24h), so a refresh
  inside that window would have returned the cached list — an app calling `refresh()` to
  pick up new server tools could have kept the old set. Every internal `tools/list` now
  sends `cacheMode: 'refresh'`, as does `list_resources` — a listing's job is to report what
  exists now, and a cached one reads to the model like its write silently failed.
  `read_resource` deliberately still honours the server's TTL: contents can be large, and
  the SDK already evicts per-URI on `notifications/resources/updated`.
- `rehydrateMCPTools()` no longer replays a snapshot's `sessionId`. With one present, SDK v2
  skips negotiation entirely and leaves server capabilities and version undefined without
  erroring — so the replayed handle would silently lose its resource tools. Sessions are
  removed in 2026-07-28 anyway (SEP-2567), so the replay does a fresh handshake.
- A failed `connect()` no longer leaks its transport. The SDK does not close a transport
  whose `start()` threw, so a rejected connection left an open keep-alive socket — most
  visibly on the new probe-failure path, where a strict gateway leaked one per attempt.
- `protocolNegotiation: { pin }` now autocompletes and typo-checks the two known revisions
  (`'2025-11-25'`, `'2026-07-28'`) while still accepting any other string, so pinning a
  future revision compiles without a cast. The revision union is exported as
  `MCPProtocolRevision`.
- New test coverage for both protocol eras over `InMemoryTransport`, for the
  Streamable HTTP → SSE fallback, for `tools/list_changed` dispatch end to end, and for the
  `clientInfo` we self-report.

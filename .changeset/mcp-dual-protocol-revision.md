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

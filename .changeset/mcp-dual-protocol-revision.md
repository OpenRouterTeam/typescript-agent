---
'@openrouter/mcp': major
---

Support both MCP protocol revisions. Any server now works out of the box, whether it
speaks `2025-11-25` or `2026-07-28`.

Migrates from `@modelcontextprotocol/sdk@^1.29.0` to `@modelcontextprotocol/client@^2.0.0`
and adds `protocolNegotiation?: 'legacy' | 'auto' | { pin: string }`, defaulting to
`'auto'`. Under `'auto'` the client probes with `server/discover` and then speaks whichever
revision the server offers — the per-request `_meta` envelope for `2026-07-28`, or the
classic `initialize` handshake for `2025-11-25` and earlier.

**Breaking:** Node 20+ is required — `@modelcontextprotocol/client@2.0.0` declares
`engines.node: >=20`, and this package now declares the same so Node 18/19 consumers get an
install-time warning instead of a runtime failure.

**Breaking:** if you pass `auth: { kind: 'oauth', provider }`, your provider must satisfy
`@modelcontextprotocol/client@2.0.0`'s `OAuthClientProvider` — change the import specifier,
and note `tokens()` now returns `StoredOAuthTokens` (same fields, so most providers compile
unchanged). Type it with the newly exported `MCPOAuthClientProvider` to avoid depending on
that path again.

`protocolNegotiation` defaults to `'auto'`, where the SDK defaults to `'legacy'`, so every
connection's first request is a `server/discover` probe. **This is not a connectivity
break:** when you have not set `protocolNegotiation` yourself, a failed connect is retried
once with `'legacy'`, so a proxy, WAF, or gateway that hangs or 5xx's on an unknown method
still connects exactly as it did before. Modern servers get `2026-07-28`, everything else
lands where it always did.

The `server/discover` probe is bounded at **30s** (`probeTimeoutMs` to change it). The SDK
otherwise gives the probe the full 60s request timeout, which under `'auto'` — where the probe
is the first request of every connection — would mean minutes of hang against a gateway that
black-holes requests. It is not tighter than that on purpose: on HTTP a probe *timeout* is
classified as an outage and the legacy retry sends an `initialize` that revision 2026-07-28
removed, so a modern-only server slower than the ceiling would fail to connect rather than
merely take longer. Serverless cold starts make an aggressive value a correctness problem.

The cost lands only on already-failing connects: the retry re-walks the same transport ladder
under `'legacy'`, so a genuinely unreachable server is dialled up to four times rather than
two. The retry deliberately does *not* pin one transport — a legacy server reachable only
over SSE, behind probe-hostile infrastructure, needs SSE offered again under `'legacy'` or it
stops connecting entirely, which is the regression this mechanism exists to prevent.

The retry is skipped on an auth failure — the SDK's `UnauthorizedError`, or (when an OAuth
provider is configured) a **401** status from the probe, which the SDK reports as an
`SdkHttpError` instead of routing through the OAuth flow. A **403** always degrades, even
under OAuth: the SDK's PKCE side effects live exclusively behind its 401 branch, so a 403
retry re-drives nothing — while gateways commonly answer unknown methods with 403, which is
the very scenario the retry exists to rescue. Auth failures are recognised whether they came
from the last attempt or an earlier one. Rejected credentials are not something a different protocol revision fixes, and re-running
the attempt would drive an OAuth provider's authorization flow a second time and overwrite the
stored PKCE verifier.

`connect`-level calls accept a `signal` that aborts the whole ladder — every transport
attempt, the probe, and the implicit legacy retry — so a caller with its own deadline can
bound the worst case (~3 minutes against a black-holing gateway on the default path). An
aborted connect is never retried. Snapshot replays also no longer perform the construction
write-back: the snapshot it would write is the one just read, so it was a store round-trip
per rehydrate buying nothing. Three maintenance writes survive, all best-effort: an OAuth
provider under `cacheCredentials: true` re-persists its current tokens (so the stored entry
tracks rotation instead of expiring into a forced fresh connect), a rotated static credential
(`bearer`/`headers` auth passed by the caller under `cacheCredentials: true`) updates the
stored header block the same way, and an entry carrying a
legacy `sessionId` from an earlier version is rewritten once without it. Every maintenance write reads the
store first and only ever rewrites an entry it already holds: the rotation writes graft the
credential block onto the stored entry (never the caller's possibly-older input snapshot, which could
roll back a newer entry written by a concurrent `refresh()`), skip entirely when the stored
entry never held that credential block, and write nothing at all when the credential is
unchanged — an unrotated OAuth token in particular is never re-persisted, which would ratchet
its recorded expiry forward (`expires_in` is relative to issuance) and could drop stored
fields the provider no longer reports — `expires_in` is relative to issuance, so restamping it per replay would
push the recorded expiry forward forever. No maintenance write can introduce credentials into a
store that lacked them. If your store implementation extends entry TTLs on write
(Redis `SETEX`-style), note that warm hits no longer touch the store, so such entries now
expire on their own schedule rather than being kept alive by access; size the TTL to the
staleness window you actually want.

`MCPConnectionError` now carries every underlying failure in `errors` (matching
`AggregateError`), flat and in attempt order across both negotiation passes, so a caller sees
all of them rather than only the last — which is all `cause` holds.

An **explicit** `protocolNegotiation` is honoured exactly, including `'auto'` — asking for a
mode means asking for its failures too, and silently overriding a `{ pin }` would defeat the
point of pinning. Pass `'legacy'` to skip the probe entirely.

```ts
import { createMCPTools, type MCPOAuthClientProvider } from '@openrouter/mcp';

// Default: probes with `server/discover`, then speaks whichever revision the
// server offers. If the probe fails — a gateway that rejects unknown methods —
// this retries once with the classic `initialize` handshake, so a server that
// worked before still connects.
const mcp = await createMCPTools({ url: 'https://mcp.example.com/mcp' });

// Skip the probe entirely. Saves the extra round trip if you already know the
// server is 2025-era. Not required for compatibility — the default degrades on
// its own.
const legacy = await createMCPTools({
  url: 'https://mcp.example.com/mcp',
  protocolNegotiation: 'legacy',
});

// Explicit modes are honoured exactly — this one fails rather than degrading.
const strict = await createMCPTools({
  url: 'https://mcp.example.com/mcp',
  protocolNegotiation: 'auto',
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

Cache writes are best-effort, the probe is tunable, and multi-attempt failures carry every
underlying error:

```ts
import {
  createMCPTools,
  MCPCacheWriteError,
} from '@openrouter/mcp';

// New option: ceiling on the `server/discover` probe (default 30s). Raise for a
// server slow to answer its first request; lower to fail fast on infrastructure
// you control.
const mcp = await createMCPTools({
  url: 'https://mcp.example.com/mcp',
  probeTimeoutMs: 60_000,
});

// New export: a store outage no longer fails the call — the handle stays usable
// and only the cache entry is stale. Catch it from refresh() to treat a write
// failure as fatal anyway.
try {
  await mcp.refresh();
} catch (err) {
  if (err instanceof MCPCacheWriteError) {
    // Tools were re-read successfully; only persisting the snapshot failed.
    metrics.increment('mcp.cache_write_failed');
  } else {
    throw err;
  }
}
```

When more than one transport was tried, `MCPConnectionError` carries every underlying failure
on `errors` — `cause` still holds the last one, which on its own hides an auth rejection from
an earlier attempt:

```ts
import { createMCPTools, MCPConnectionError } from '@openrouter/mcp';

try {
  await createMCPTools({ url: 'https://mcp.example.com/mcp' });
} catch (err) {
  if (err instanceof MCPConnectionError) {
    console.error('last attempt:', err.cause);
    // Every attempt's failure, flat and in order — a single-attempt failure
    // contributes its one underlying error, so this is never empty.
    for (const attempt of err.errors) {
      console.error('attempt:', attempt);
    }
  }
  throw err;
}
```

Rehydrating a snapshot now enforces `staleness.maxAgeMs` on every path, including
`reconnectOnExpiry: false`. If the re-list that would refresh an over-age snapshot fails,
the call rejects rather than quietly serving tools you declared too old — catch
`MCPStaleSnapshotError` to opt back into stale-but-usable tools:

```ts
import {
  rehydrateMCPTools,
  MCPStaleSnapshotError,
  type MCPProtocolRevision,
} from '@openrouter/mcp';

async function load(snapshot: SerializedMCPServer) {
  try {
    // Over-age snapshots re-list over the replayed connection. New: this holds
    // under `reconnectOnExpiry: false` too, where it previously replayed silently.
    return await rehydrateMCPTools({
      snapshot,
      staleness: { maxAgeMs: 60_000 },
      reconnectOnExpiry: false,
    });
  } catch (err) {
    if (err instanceof MCPStaleSnapshotError) {
      // The connection is fine; only the re-list failed. Accept the cached
      // tool set rather than failing the request.
      return await rehydrateMCPTools({ snapshot, reconnectOnExpiry: false });
    }
    throw err;
  }
}

// The two known revisions autocomplete and typo-check; any other string still
// compiles, so pinning a future revision needs no cast.
const revision: MCPProtocolRevision = '2026-07-28';
await createMCPTools({
  url: 'https://mcp.example.com/mcp',
  protocolNegotiation: { pin: revision },
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
- Your `MCPCacheStore` failing no longer fails the call, on either side. Writes are
  best-effort: a store outage previously discarded a live connection whose tools had been
  read successfully, and broke the documented stale-snapshot recovery, which writes through
  the same store. Reads are a miss: a failing `store.get` falls through to a fresh connect,
  exactly as an empty cache would. `handle.refresh()` reports a write failure as the new
  `MCPCacheWriteError` (a subclass of `MCPCacheError`) for callers who do want to treat it
  as fatal, and `onToolsChanged` subscribers are still notified whenever the re-list itself
  succeeded, whatever failed afterwards (a store write, or the OAuth provider rejecting
  while the snapshot was being built) — the
  tools were re-read successfully, and skipping the announcement would leave subscribers
  permanently out of sync with `handle.tools`.
- An auth failure no longer falls through the transport ladder. A 401 on Streamable HTTP used
  to try SSE with the same `authProvider`, re-entering the SDK's auth path for a second
  `redirectToAuthorization` and overwriting the saved PKCE verifier — the same duplicated side
  effect the negotiation retry already guarded against, one layer down.
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
- Snapshots no longer persist `sessionId` at all. A Streamable HTTP `Mcp-Session-Id` is
  bearer-equivalent to an authenticated server session, and with the replay path no longer
  reading it, writing it to a cache store was attack surface for no functionality. The field
  stays on the snapshot type so existing cache entries keep deserializing; treat any value
  found there as untrusted legacy data.
- A failed `connect()` no longer leaks its transport. The SDK does not close a transport
  whose `start()` threw, so a rejected connection left an open keep-alive socket — most
  visibly on the new probe-failure path, where a strict gateway leaked one per attempt.
- The `'auto'` probe applies to SSE as well, including a pinned `transport: 'sse'` and the
  Streamable HTTP → SSE fallback, since all three share one client factory. The legacy retry
  covers each of them, so pinning SSE for a legacy server still connects.
- `protocolNegotiation: { pin }` now autocompletes and typo-checks the two known revisions
  (`'2025-11-25'`, `'2026-07-28'`) while still accepting any other string, so pinning a
  future revision compiles without a cast. The revision union is exported as
  `MCPProtocolRevision`.
- New test coverage for both protocol eras over `InMemoryTransport`, for the
  Streamable HTTP → SSE fallback, for `tools/list_changed` dispatch end to end, and for the
  `clientInfo` we self-report.

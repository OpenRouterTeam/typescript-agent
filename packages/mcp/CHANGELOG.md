# @openrouter/mcp

## 1.1.2

### Patch Changes

- Updated dependencies [[`4dce84e`](https://github.com/OpenRouterTeam/typescript-agent/commit/4dce84e4393ec36745875512d6ad1fcd8b38e502), [`9766f31`](https://github.com/OpenRouterTeam/typescript-agent/commit/9766f31ec2390cd294ca47dd81d0122941c0d586), [`ddab365`](https://github.com/OpenRouterTeam/typescript-agent/commit/ddab3652a47edf5ebaa842447864a3dc91b812e5)]:
  - @openrouter/agent@1.0.0

## 1.1.1

### Patch Changes

- Updated dependencies [[`c610b6e`](https://github.com/OpenRouterTeam/typescript-agent/commit/c610b6ef0b880083821afd588717d635943c07ee), [`17418f7`](https://github.com/OpenRouterTeam/typescript-agent/commit/17418f7c469e09efd9d61980315b9727b1d11ff6), [`8a922b5`](https://github.com/OpenRouterTeam/typescript-agent/commit/8a922b5360addf6b5670c7fc4c87780f4fdfa071), [`7416059`](https://github.com/OpenRouterTeam/typescript-agent/commit/7416059a3644af577ef2969b932a6614771e0c43)]:
  - @openrouter/agent@0.11.0

## 1.1.0

### Minor Changes

- [#102](https://github.com/OpenRouterTeam/typescript-agent/pull/102) [`787cbf8`](https://github.com/OpenRouterTeam/typescript-agent/commit/787cbf8b22bf2b8071e81e2dbf84ecd871a5e824) Thanks [@LukasParke](https://github.com/LukasParke)! - Add the full MCP integration under the canonical `@openrouter/agent/mcp` subpath. `@modelcontextprotocol/client` is an optional peer, so base agent installations and imports do not install or load MCP support. The existing `@openrouter/mcp` package remains as a compatibility facade and now re-exports the canonical agent subpaths.

  ```ts
  import { callModel, OpenRouter } from "@openrouter/agent";
  import { createMCPTools } from "@openrouter/agent/mcp";

  const mcp = await createMCPTools({ url: "https://mcp.example.com/mcp" });
  const result = callModel(new OpenRouter(), {
    model: "openai/gpt-4o-mini",
    input: "Use the remote tools.",
    tools: mcp.tools,
  });
  ```

  Install `@modelcontextprotocol/client` alongside `@openrouter/agent` when using `/mcp`. The SDK is loaded lazily, so importing the base agent or the MCP entry point does not require the peer; the first MCP connection attempt without it throws an actionable `MCPMissingPeerDependencyError`.

  Existing `@openrouter/mcp` imports continue to work as tooling-visible deprecated migration facades, but new code should prefer `@openrouter/agent/mcp`. The facade would only be removed in a future breaking release after migration notice.

  The `@openrouter/mcp` facade continues to install `@modelcontextprotocol/client` transitively for backward compatibility; only direct `@openrouter/agent/mcp` users need to add the optional peer explicitly.

### Patch Changes

- Updated dependencies [[`787cbf8`](https://github.com/OpenRouterTeam/typescript-agent/commit/787cbf8b22bf2b8071e81e2dbf84ecd871a5e824), [`8d2ed61`](https://github.com/OpenRouterTeam/typescript-agent/commit/8d2ed61964aa063936763c7b80f6b5bf389fa144), [`66d7232`](https://github.com/OpenRouterTeam/typescript-agent/commit/66d7232d53d9881c5842c77f8bc342314724bf3b)]:
  - @openrouter/agent@0.10.0

## 1.0.0

### Major Changes

- [#86](https://github.com/OpenRouterTeam/typescript-agent/pull/86) [`53d71cc`](https://github.com/OpenRouterTeam/typescript-agent/commit/53d71cc217a17dd2a8c279bc138e613b5c840bc2) Thanks [@LukasParke](https://github.com/LukasParke)! - Support both MCP protocol revisions. Any server now works out of the box, whether it
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
  black-holes requests. It is not tighter than that on purpose: on HTTP a probe _timeout_ is
  classified as an outage and the legacy retry sends an `initialize` that revision 2026-07-28
  removed, so a modern-only server slower than the ceiling would fail to connect rather than
  merely take longer. Serverless cold starts make an aggressive value a correctness problem.

  The cost lands only on already-failing connects: the retry re-walks the same transport ladder
  under `'legacy'`, so a genuinely unreachable server is dialled up to four times rather than
  two. The retry deliberately does _not_ pin one transport — a legacy server reachable only
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
  import { createMCPTools, type MCPOAuthClientProvider } from "@openrouter/mcp";

  // Default: probes with `server/discover`, then speaks whichever revision the
  // server offers. If the probe fails — a gateway that rejects unknown methods —
  // this retries once with the classic `initialize` handshake, so a server that
  // worked before still connects.
  const mcp = await createMCPTools({ url: "https://mcp.example.com/mcp" });

  // Skip the probe entirely. Saves the extra round trip if you already know the
  // server is 2025-era. Not required for compatibility — the default degrades on
  // its own.
  const legacy = await createMCPTools({
    url: "https://mcp.example.com/mcp",
    protocolNegotiation: "legacy",
  });

  // Explicit modes are honoured exactly — this one fails rather than degrading.
  const strict = await createMCPTools({
    url: "https://mcp.example.com/mcp",
    protocolNegotiation: "auto",
  });

  // Or pin one revision explicitly.
  const pinned = await createMCPTools({
    url: "https://mcp.example.com/mcp",
    protocolNegotiation: { pin: "2026-07-28" },
  });

  // OAuth providers: type against the new export rather than the SDK path.
  const provider: MCPOAuthClientProvider = myProvider;
  await createMCPTools({
    url: "https://mcp.example.com/mcp",
    auth: { kind: "oauth", provider },
  });
  ```

  Cache writes are best-effort, the probe is tunable, and multi-attempt failures carry every
  underlying error:

  ```ts
  import { createMCPTools, MCPCacheWriteError } from "@openrouter/mcp";

  // New option: ceiling on the `server/discover` probe (default 30s). Raise for a
  // server slow to answer its first request; lower to fail fast on infrastructure
  // you control.
  const mcp = await createMCPTools({
    url: "https://mcp.example.com/mcp",
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
      metrics.increment("mcp.cache_write_failed");
    } else {
      throw err;
    }
  }
  ```

  When more than one transport was tried, `MCPConnectionError` carries every underlying failure
  on `errors` — `cause` still holds the last one, which on its own hides an auth rejection from
  an earlier attempt:

  ```ts
  import { createMCPTools, MCPConnectionError } from "@openrouter/mcp";

  try {
    await createMCPTools({ url: "https://mcp.example.com/mcp" });
  } catch (err) {
    if (err instanceof MCPConnectionError) {
      console.error("last attempt:", err.cause);
      // Every attempt's failure, flat and in order — a single-attempt failure
      // contributes its one underlying error, so this is never empty.
      for (const attempt of err.errors) {
        console.error("attempt:", attempt);
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
  } from "@openrouter/mcp";

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
  const revision: MCPProtocolRevision = "2026-07-28";
  await createMCPTools({
    url: "https://mcp.example.com/mcp",
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

### Minor Changes

- [#74](https://github.com/OpenRouterTeam/typescript-agent/pull/74) [`f412281`](https://github.com/OpenRouterTeam/typescript-agent/commit/f4122818afe99c2586584a23436da90c10009caf) Thanks [@LukasParke](https://github.com/LukasParke)! - Doom-loop `loopKey` support for MCP-wrapped tools (pairs with `@openrouter/agent`'s `doomLoop` option).

  Two ways to declare a wrapped tool's call identity: a client-side `loopKeys` map on `createMCPTools`/`rehydrateMCPTools` (keyed by unprefixed MCP tool name; any `ToolLoopKey` form — function, field-name array, or `false` to exempt), and a server-advertised `_meta['openrouter/loopKey']` on the tool definition (data-only: field-name array or `false`). Client config takes precedence. Server-advertised declarations ride the cache snapshot (`SerializedMCPToolDef.loopKey`), so rehydrated tool sets keep their identities without a `listTools()` round-trip; function forms are client-side only and cannot be cached.

  ```ts
  import { createMCPTools } from "@openrouter/mcp";

  const mcp = await createMCPTools({
    url: "https://mcp.example.com/mcp",
    // Keyed by the UNPREFIXED MCP tool name, even when toolNamePrefix is set.
    // Any ToolLoopKey form: a field-name array, `false` to exempt, or a
    // function computing key material (client-side only — not cacheable).
    loopKeys: {
      run_command: ["command", "cwd"],
      poll_job: false,
    },
    cache: { store },
  });

  const result = client.callModel({
    model: "z-ai/glm-5.2",
    input: "Get the build passing.",
    tools: mcp.tools,
    doomLoop: true,
  });
  ```

  A server can advertise the same thing itself via
  `_meta['openrouter/loopKey']` on the tool definition (data-only: a field-name
  array or `false`). Client `loopKeys` win over a server declaration, and
  server-advertised values survive a cache round-trip via
  `SerializedMCPToolDef.loopKey`.

### Patch Changes

- [#86](https://github.com/OpenRouterTeam/typescript-agent/pull/86) [`53d71cc`](https://github.com/OpenRouterTeam/typescript-agent/commit/53d71cc217a17dd2a8c279bc138e613b5c840bc2) Thanks [@LukasParke](https://github.com/LukasParke)! - Generate the `clientInfo` version from `package.json` instead of hardcoding it. `build`
  regenerates `src/version.ts`, and a unit test fails if the committed value drifts, so the
  version reported to MCP servers cannot go stale across a release.
- Updated dependencies [[`e8d7d6d`](https://github.com/OpenRouterTeam/typescript-agent/commit/e8d7d6dc194dd6029a180a1f23a9935c01c57e6f), [`78c562e`](https://github.com/OpenRouterTeam/typescript-agent/commit/78c562ef53da0edd84dfbcc6d6ee38a095d72b37), [`78c562e`](https://github.com/OpenRouterTeam/typescript-agent/commit/78c562ef53da0edd84dfbcc6d6ee38a095d72b37), [`75271c3`](https://github.com/OpenRouterTeam/typescript-agent/commit/75271c31fdd5ec620f23d75908664b99428d753a), [`5a7ed03`](https://github.com/OpenRouterTeam/typescript-agent/commit/5a7ed03e5acf47e640ec027dbd3c713f115a054a), [`a629cf1`](https://github.com/OpenRouterTeam/typescript-agent/commit/a629cf10d8eaf01adeaf04eaedc9061ad55e5db0), [`78c562e`](https://github.com/OpenRouterTeam/typescript-agent/commit/78c562ef53da0edd84dfbcc6d6ee38a095d72b37), [`3028554`](https://github.com/OpenRouterTeam/typescript-agent/commit/3028554bc2aec3e3e415670043777f9898d13681), [`231fb65`](https://github.com/OpenRouterTeam/typescript-agent/commit/231fb6578e13c0a7578e54b78392f4cff57221c9), [`0efdbb0`](https://github.com/OpenRouterTeam/typescript-agent/commit/0efdbb0cbade947f5ad58a678e97b01f9ead07c9)]:
  - @openrouter/agent@0.9.0

## 0.0.1

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

- Updated dependencies [[`1362232`](https://github.com/OpenRouterTeam/typescript-agent/commit/1362232975f0254343f9842f30ec1b35d391f4fe), [`c83cceb`](https://github.com/OpenRouterTeam/typescript-agent/commit/c83cceb17ec1d66b9a1fd2d46ac8ac9b6e60fa4c), [`6807c51`](https://github.com/OpenRouterTeam/typescript-agent/commit/6807c51d56a35e07a2c549d92ab6d8a0c106ac0a), [`09a041e`](https://github.com/OpenRouterTeam/typescript-agent/commit/09a041ea717b384c6c85d7c81ef391b170b0dd8f), [`e4d06e3`](https://github.com/OpenRouterTeam/typescript-agent/commit/e4d06e38215d6eafbd5c198e3485f476e65d26f0), [`c020bc7`](https://github.com/OpenRouterTeam/typescript-agent/commit/c020bc7c86d2f743ecf9158ca3c9ff7b315e43b3), [`d96cd9f`](https://github.com/OpenRouterTeam/typescript-agent/commit/d96cd9fc589c27978bcdc2fd1921f754be88e3f0), [`80ff8a7`](https://github.com/OpenRouterTeam/typescript-agent/commit/80ff8a730292aa00a3acfcce6ab1e9f5a6a7f0de), [`209499a`](https://github.com/OpenRouterTeam/typescript-agent/commit/209499abacd6783ee5c98155bb2a676e3932c3f4), [`8edae63`](https://github.com/OpenRouterTeam/typescript-agent/commit/8edae63f4f6fe89e146f3abbf6d24dab7a164681), [`cb83f45`](https://github.com/OpenRouterTeam/typescript-agent/commit/cb83f45209ff66f8c58077f4e0a85d35f884afdb)]:
  - @openrouter/agent@0.8.0

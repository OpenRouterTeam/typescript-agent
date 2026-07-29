# @openrouter/mcp

Expose the tools of a remote [Model Context Protocol](https://modelcontextprotocol.io) server
(Streamable HTTP or SSE) as tools you can pass straight into
[`@openrouter/agent`](https://www.npmjs.com/package/@openrouter/agent)'s `callModel`.

- Connect to a non-stdio MCP server, authenticate **once**, and reuse that auth for tool
  discovery and every tool call.
- Faithful JSON Schema → Zod conversion so the model sees real parameters.
- Serializable, rehydratable cache so you can skip re-listing (and, opt-in, re-authenticating).
- Progress streaming, `tools/list_changed` auto-refresh, cancellation, resources, and elicitation.
- Speaks both MCP protocol revisions (`2025-11-25` and `2026-07-28`), negotiated per server.

> stdio servers are intentionally out of scope.

## Install

```bash
pnpm add @openrouter/mcp @openrouter/agent
```

## Quick start

```ts
import { OpenRouter } from '@openrouter/agent';
import { callModel } from '@openrouter/agent/call-model';
import { createMCPTools } from '@openrouter/mcp';

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const mcp = await createMCPTools({
  url: 'https://mcp.example.com/mcp',
  auth: { kind: 'bearer', token: process.env.MCP_TOKEN },
});

const result = callModel(client, {
  model: 'anthropic/claude-opus-4-8',
  input: 'What are my three most recently updated issues?',
  tools: mcp.tools,
});

console.log(await result.getText());
await mcp.close();
```

## Authentication

Auth is supplied once and reused for discovery and every call:

```ts
// Static bearer token
auth: { kind: 'bearer', token }
// Arbitrary headers
auth: { kind: 'headers', headers: { 'X-API-Key': key } }
// Pluggable OAuth (you own token refresh/storage)
auth: { kind: 'oauth', provider }
```

Prefer an OAuth provider over caching static tokens — the transport refreshes through it
automatically. Type yours with `MCPOAuthClientProvider`, re-exported from this package.

## Caching & rehydration

Persist a snapshot and rebuild later without a `listTools()` round-trip:

```ts
import { createMCPTools, rehydrateMCPTools } from '@openrouter/mcp';

const mcp = await createMCPTools({ url, auth, cacheCredentials: true });
const snapshot = await mcp.serialize();   // plain JSON — store anywhere
await mcp.close();

const mcp2 = await rehydrateMCPTools({ snapshot, auth });
```

Or let a store manage it (rehydrate on hit, connect + write on miss):

```ts
import { InMemoryMCPCacheStore } from '@openrouter/mcp';

const store = new InMemoryMCPCacheStore(); // or your own Redis/DB-backed MCPCacheStore
const mcp = await createMCPTools({
  url,
  auth,
  cache: { store, key: `mcp:${userId}` },
  staleness: { maxAgeMs: 60 * 60 * 1000 },
});
```

> **Security:** `cacheCredentials` is `false` by default. When enabled, snapshots contain bearer
> tokens/headers — treat the store as a secret store and namespace cache keys by principal in
> multi-tenant setups.

## Multiple servers

```ts
const [github, linear] = await Promise.all([
  createMCPTools({ url: githubUrl, auth: gh, toolNamePrefix: 'github_' }),
  createMCPTools({ url: linearUrl, auth: ln, toolNamePrefix: 'linear_' }),
]);

const result = callModel(client, {
  model,
  input: 'Find the Linear issue linked to GitHub PR #42.',
  tools: [...github.tools, ...linear.tools],
});
```

## Options

| Option | Description |
| --- | --- |
| `url` | Remote MCP server endpoint. |
| `transport` | `'streamableHttp'` (default, falls back to SSE) or `'sse'` (deprecated upstream). |
| `protocolNegotiation` | `'auto'` (default), `'legacy'`, or `{ pin }`. See Protocol revisions. |
| `auth` | Bearer token, headers, or an `OAuthClientProvider`. |
| `toolNamePrefix` | Prefix every wrapped tool name. |
| `includeTools` / `excludeTools` | Allow/deny lists by MCP tool name. |
| `onUnconvertibleSchema` | `'looseLeaf'` (default) or `'throw'` for exotic JSON Schema. |
| `cache` / `cacheCredentials` / `staleness` | Caching controls. |
| `resources` | Expose synthetic `list_resources` / `read_resource` tools (default on). |
| `emitProgress` | Stream MCP progress as generator-tool events (default on). |
| `autoRefreshOnListChanged` | Re-list on `tools/list_changed` (default on). |
| `onElicitation` | Handle elicitation requests (both revisions); auto-declines when omitted. |
| `signal` | Abort signal threaded into every tool call. |

## Client identity

The client identifies itself to every server it connects to via MCP `clientInfo`
(`{ name, version }`). Pass `clientInfo` in options to override it; otherwise the default
is `@openrouter/mcp` at this package's version.

That version is **generated** into `src/version.ts` from `package.json`, which is the
single source of truth. `build` regenerates it, so a changesets version bump is picked up
automatically before publish. To regenerate by hand:

```bash
pnpm --filter @openrouter/mcp gen:version
```

The generated file is committed rather than gitignored, because CI's lint, typecheck, and
unit-test jobs compile `src` without running a build. `tests/unit/version.test.ts` fails
if the committed constant drifts from `package.json`, so a stale value cannot merge.

## Protocol revisions

Both current MCP revisions are supported, and the right one is chosen for you. Point this
at any server and it works:

```ts
const mcp = await createMCPTools({ url: 'https://mcp.example.com/mcp' });
```

By default (`protocolNegotiation: 'auto'`) the client probes with `server/discover` and
then speaks whichever revision the server offers:

| Server | What goes on the wire |
| --- | --- |
| **`2026-07-28`** | `server/discover`, then requests carrying the per-request `_meta` envelope and `Mcp-Method` / `Mcp-Name` headers. No `initialize` — the handshake is removed in this revision (SEP-2575). |
| **`2025-11-25`** and earlier | `server/discover`, then a fallback to the classic `initialize` + `notifications/initialized` handshake, byte-equivalent to a 2025-only client. |

Override when you need to:

```ts
// Skip the probe. Useful on flaky servers: over HTTP a probe timeout is treated
// as an outage and rejects, where 'legacy' may still connect.
await createMCPTools({ url, protocolNegotiation: 'legacy' });

// Require a specific revision; fail loudly rather than falling back.
await createMCPTools({ url, protocolNegotiation: { pin: '2026-07-28' } });
```

`'auto'` costs one extra round trip against legacy servers. There are no hardcoded
protocol version strings in this package — negotiation is delegated to
`@modelcontextprotocol/client`.

### What differs between the revisions

Mostly nothing you need to care about, with three exceptions:

| Surface | Behavior |
| --- | --- |
| `onElicitation` | **Works on both.** On 2025-era servers it handles `elicitation/create`; on 2026-07-28 that request is gone, but the SDK's multi-round-trip driver (SEP-2322) routes `input_required` results through the same handler and retries the call. |
| `sessionId` | 2025-era only. Protocol sessions and `Mcp-Session-Id` are removed in 2026-07-28 (SEP-2567), so it is `undefined` there. Snapshots keep the field so older ones still deserialize. |
| `transport: 'sse'` | Still supported for legacy servers, but HTTP+SSE is reclassified Deprecated (SEP-2596). Prefer `streamableHttp`. |

Sampling and Roots are deprecated in the new revision and were never implemented here, so
there is nothing to migrate.

The SDK also keeps its own per-client response cache (24h ceiling), independent of the
`MCPCacheStore` described above. The two are unrelated: `MCPCacheStore` persists a tool
snapshot across processes and, opt-in, credentials.

### OAuth provider types

If you pass `{ kind: 'oauth', provider }`, type your provider with
`MCPOAuthClientProvider` from this package rather than importing from
`@modelcontextprotocol/client` — that import path is an implementation detail and has
changed once already.

## License

Apache-2.0

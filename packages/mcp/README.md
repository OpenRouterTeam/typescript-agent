# @openrouter/mcp

Expose the tools of a remote [Model Context Protocol](https://modelcontextprotocol.io) server
(Streamable HTTP or SSE) as tools you can pass straight into
[`@openrouter/agent`](https://www.npmjs.com/package/@openrouter/agent)'s `callModel`.

- Connect to a non-stdio MCP server, authenticate **once**, and reuse that auth for tool
  discovery and every tool call.
- Faithful JSON Schema → Zod conversion so the model sees real parameters.
- Serializable, rehydratable cache so you can skip re-listing (and, opt-in, re-authenticating).
- Progress streaming, `tools/list_changed` auto-refresh, cancellation, resources, and elicitation.

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

Prefer an `OAuthClientProvider` over caching static tokens — the transport refreshes through it
automatically.

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
| `auth` | Bearer token, headers, or an `OAuthClientProvider`. |
| `toolNamePrefix` | Prefix every wrapped tool name. |
| `includeTools` / `excludeTools` | Allow/deny lists by MCP tool name. |
| `onUnconvertibleSchema` | `'looseLeaf'` (default) or `'throw'` for exotic JSON Schema. |
| `cache` / `cacheCredentials` / `staleness` | Caching controls. |
| `resources` | Expose synthetic `list_resources` / `read_resource` tools (default on). |
| `emitProgress` | Stream MCP progress as generator-tool events (default on). |
| `autoRefreshOnListChanged` | Re-list on `tools/list_changed` (default on). |
| `onElicitation` | Handle server elicitation requests; auto-declines when omitted. |
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

## Protocol revision

This package delegates protocol version negotiation entirely to
`@modelcontextprotocol/sdk` (pinned `^1.29.0`), which negotiates **`2025-11-25`** and
supports `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`. There are no
hardcoded protocol version strings here.

MCP revision **`2026-07-28`** is published but this package does not speak it yet, and
that is deliberate: as of this writing no released SDK negotiates it by default.
`@modelcontextprotocol/client@2.0.0` still sends the `initialize` handshake with
`protocolVersion: "2025-11-25"` and omits the `Mcp-Method` / `Mcp-Name` headers the new
revision requires, so migrating today would change our dependency tree without changing
a single byte on the wire.

Three parts of this package's surface target primitives `2026-07-28` removes. They keep
working against the revisions the pinned SDK negotiates, and are marked `@deprecated` so
the eventual break is not a surprise:

| Surface | Fate under `2026-07-28` |
| --- | --- |
| `sessionId` (snapshot field, reconnect replay) | Protocol-level sessions and `Mcp-Session-Id` **removed** (SEP-2567); cross-call state becomes server-minted handles passed as tool arguments. |
| `onElicitation` | Server-initiated `elicitation/create` **removed**, replaced by Multi Round-Trip Requests (SEP-2322): an `input_required` result plus a client retry carrying `inputResponses`. |
| `transport: 'sse'` | HTTP+SSE reclassified **Deprecated** (SEP-2596). |

Also relevant when the migration happens: `resultType` and `ttlMs`/`cacheScope` become
required result fields, `resources/subscribe` gives way to `subscriptions/listen`, and
resource-not-found renumbers from `-32002` to `-32602`. Sampling and Roots are deprecated
in the new revision and were never implemented here, so they need no migration.

Snapshots written by earlier versions must keep deserializing — `isSerializedMCPServer`
validates untrusted snapshots, so any format change is a data-compatibility concern, not
only a code one.

## License

Apache-2.0

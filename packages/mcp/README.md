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
| `transport` | `'streamableHttp'` (default, falls back to SSE) or `'sse'`. |
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

## License

Apache-2.0

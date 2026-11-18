---
'@openrouter/agent': patch
---

Fix three bugs in the MCP integration (`@openrouter/agent/mcp`).

**Tool arguments are no longer dropped for composed input schemas.** When a tool's `inputSchema` could not be converted to Zod as a whole (a root `oneOf` / `anyOf` / `allOf`, `if`/`then`/`else`, `not`, a draft-07 `#/definitions/` `$ref`), the fallback validated with an object that kept only the root-level `properties` and stripped everything else. The model, which is sent the server's own schema, sent valid arguments and the server received `{}` or a partial object. The fallback now passes unknown keys through to the server. The same applies to `outputSchema`, so fields of `structuredContent` are no longer stripped either.

**`autoRefreshOnListChanged` now works against 2026-07-28 servers.** That revision delivers `notifications/tools/list_changed` only on a `subscriptions/listen` stream, which was never opened, so the default-on auto-refresh and `onToolsChanged` never fired. When auto-refresh is enabled and the server advertises `tools.listChanged`, the handle now opens that stream in the background, re-opens it with backoff if it ends (re-listing once, since changes made in between were not announced), and closes it on `close()`. Opening it never delays or fails `createMCPTools` / `rehydrateMCPTools`. 2025-era connections are unchanged. Note that the handle holds this stream open until you call `close()`.

**A warm cache no longer pins the transport recorded in its entry.** A cached entry written after an SSE fallback made every later call dial SSE only, so a server that dropped SSE became unreachable through the cache while the same call without a cache connected. The recorded transport is now a first-attempt hint: if it fails, the call falls back to a fresh connect over the default Streamable HTTP → SSE ladder and rewrites the entry. A caller's `transport` is now honoured on a cache hit (it was ignored), and `rehydrateMCPTools` accepts `transport` too.

```ts
import {
  createMCPTools,
  InMemoryMCPCacheStore,
  rehydrateMCPTools,
} from '@openrouter/agent/mcp';

const store = new InMemoryMCPCacheStore();

// `transport` on a cache hit. was: ignored, the entry's transport was dialled.
const mcp = await createMCPTools({ url, auth, transport: 'streamableHttp', cache: { store } });

// No `transport`: the entry's transport is tried first. was: the only one ever
// tried. now: on failure, falls back to Streamable HTTP -> SSE and rewrites the entry.
const warm = await createMCPTools({ url, auth, cache: { store } });

// new: `transport` on rehydrateMCPTools overrides the one in the snapshot.
const snapshot = await mcp.serialize();
const replayed = await rehydrateMCPTools({ snapshot, auth, transport: 'streamableHttp' });

// was: never called on a 2026-07-28 server. now: called after each re-list.
mcp.onToolsChanged((tools) => console.log(tools.length));
// opt out (no stream is opened): createMCPTools({ url, autoRefreshOnListChanged: false })
```

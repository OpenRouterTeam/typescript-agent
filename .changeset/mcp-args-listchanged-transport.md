---
'@openrouter/agent': minor
---

Fix three bugs in the MCP integration (`@openrouter/agent/mcp`), and raise the `@modelcontextprotocol/client` peer floor to `^2.2.0`.

**Peer floor: `@modelcontextprotocol/client` `^2.2.0` (was `^2.0.0`).** The handle now opens a `subscriptions/listen` stream in the background (see below). In SDK 2.0.0 and 2.1.0, closing the handle, aborting its `signal`, or the acknowledgement timing out while that request is still being sent rejects a promise inside the SDK that no caller can observe. Node reports that as an unhandled rejection and, by default, exits. SDK 2.2.0 fixed it, so upgrade the SDK together with this release.

**Tool arguments are no longer dropped for composed input schemas.** When a tool's `inputSchema` could not be converted to Zod as a whole (a root `oneOf` / `anyOf` / `allOf`, `if`/`then`/`else`, `not`, a draft-07 `#/definitions/` `$ref`), the fallback validated with an object that kept only the root-level `properties` and stripped everything else. The model, which is sent the server's own schema, sent valid arguments and the server received `{}` or a partial object. The fallback now passes unknown keys through to the server. The same applies to `outputSchema`, so fields of `structuredContent` are no longer stripped either.

**`autoRefreshOnListChanged` now works against 2026-07-28 servers.** That revision delivers `notifications/tools/list_changed` only on a `subscriptions/listen` stream, which was never opened, so the default-on auto-refresh and `onToolsChanged` never fired. When auto-refresh is enabled and the server advertises `tools.listChanged`, the handle now opens that stream in the background and closes it on `close()`. Opening it never delays or fails `createMCPTools` / `rehydrateMCPTools`. If the stream drops it is re-opened with jittered backoff and the tools are re-listed once; the tool set, the cache entry and `onToolsChanged` listeners are only touched if that listing differs from the current one. It is not re-opened after the server rejects the credentials, so a revoked OAuth token causes at most one authorization redirect from the background. 2025-era connections are unchanged.

**The open stream keeps a Node process alive until `close()`.** Against a 2026-07-28 server that advertises `tools.listChanged`, a script that never closes its handle no longer exits by itself. Call `await handle.close()` when you are done, or pass `autoRefreshOnListChanged: false` to open no stream.

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

// was: never called on a 2026-07-28 server. now: called when the tool set changes.
mcp.onToolsChanged((tools) => console.log(tools.length));
// opt out (no stream is opened): createMCPTools({ url, autoRefreshOnListChanged: false })

// new: `transport` on rehydrateMCPTools overrides the one in the snapshot.
const snapshot = await mcp.serialize();
const replayed = await rehydrateMCPTools({ snapshot, auth, transport: 'streamableHttp' });

// now required to let the process exit: each handle may hold a stream open.
await Promise.all([mcp.close(), replayed.close()]);
```

import type { Tool } from '@openrouter/agent/tool-types';
import type { BuildToolsOptions } from './build-tools.js';
import { buildTools } from './build-tools.js';
import type { SerializedMCPServer } from './cache/cache-types.js';
import type { SerializeInput } from './cache/serialize.js';
import { serializeServer } from './cache/serialize.js';
import { closeQuietly } from './close-quietly.js';
import { MCPCacheWriteError } from './errors.js';
import type { MCPConnection } from './mcp-connection.js';
import { connect } from './mcp-connection.js';
import type { McpToolDef } from './tool-wrapper.js';
import type { MCPTransportKind } from './transport-types.js';
import type { CreateMCPToolsOptions, MCPToolsHandle } from './types.js';

export function normalizeUrl(url: string | URL): URL {
  return url instanceof URL ? url : new URL(url);
}

// Hard cap on pagination pages. A well-behaved server terminates the cursor
// chain by omitting `nextCursor`; this bounds a misbehaving one that never does.
const MAX_LIST_PAGES = 1000;

/**
 * Normalize a paginated `nextCursor` field: treat anything that is not a
 * non-empty string as "no more pages" so a malformed cursor terminates the loop.
 */
function nextCursorOrUndefined(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Parse a server-advertised doom-loop identity from a tool definition's
 * `_meta['openrouter/loopKey']`: a field-name array (the declarative subset
 * of arguments identifying a call) or `false` (tool exempt). Data-only by
 * design — functions can't cross the wire; any other shape is ignored.
 */
function advertisedLoopKey(
  meta: Record<string, unknown> | undefined,
): readonly string[] | false | undefined {
  const advertised = meta?.['openrouter/loopKey'];
  if (advertised === false) {
    return false;
  }
  if (Array.isArray(advertised) && advertised.every((f) => typeof f === 'string')) {
    return advertised as string[];
  }
  return undefined;
}

/**
 * Read the discovered tools off the live connection into our internal shape.
 *
 * `tools/list` is paginated: each response may carry a `nextCursor` that must be
 * passed back as `{ cursor }` to fetch the next page. We accumulate every page so
 * servers that paginate their tool list aren't silently truncated.
 *
 * Always `cacheMode: 'refresh'`. SDK v2 keeps a per-client response cache
 * honouring the server's `ttlMs` on `tools/list` (up to 24h), so the default
 * `'use'` would serve a still-fresh cached list without a round trip. That is
 * fine for an opportunistic read but wrong for every caller here: `refresh()`
 * documents a forced re-read, `freshConnect` is establishing the tool set for the
 * first time, and the stale-replay path exists precisely because the age of the
 * cached list is no longer acceptable. `'refresh'` fetches and re-stores, so the
 * cache stays warm for the SDK's own readers.
 *
 * `'refresh'` rather than `'bypass'` deliberately — bypass would skip the write
 * too, leaving a stale entry behind for anything that later reads with `'use'`.
 */
export async function listToolDefs(
  connection: MCPConnection,
  signal: AbortSignal | undefined,
): Promise<McpToolDef[]> {
  const requestOptions = {
    cacheMode: 'refresh' as const,
    ...(signal !== undefined && {
      signal,
    }),
  };
  const collected: McpToolDef[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const params =
      cursor !== undefined
        ? {
            cursor,
          }
        : undefined;
    const { tools, nextCursor } = await connection.client.listTools(params, requestOptions);
    for (const t of tools) {
      const loopKey = advertisedLoopKey(t._meta);
      collected.push({
        name: t.name,
        ...(t.description !== undefined && {
          description: t.description,
        }),
        inputSchema: t.inputSchema,
        ...(t.outputSchema !== undefined && {
          outputSchema: t.outputSchema,
        }),
        ...(loopKey !== undefined && {
          loopKey,
        }),
      });
    }
    const next = nextCursorOrUndefined(nextCursor);
    // Stop at the end of the chain, or if the server echoes the same cursor
    // (which would otherwise spin forever).
    if (next === undefined || next === cursor) {
      break;
    }
    cursor = next;
  }
  return collected;
}

function serverHasResources(connection: MCPConnection): boolean {
  const caps = connection.client.getServerCapabilities();
  return caps?.resources !== undefined;
}

interface HandleContext {
  url: URL;
  transport: MCPTransportKind;
  cacheKey: string;
}

export interface MakeHandleArgs {
  connection: MCPConnection;
  options: CreateMCPToolsOptions;
  context: HandleContext;
  initialToolDefs: McpToolDef[];
  /**
   * `cachedAt` to carry forward when `initialToolDefs` came from a snapshot
   * rather than a live `listTools()`. Omit on a cold connect so the write
   * stamps now.
   *
   * Without this a replay would restamp `cachedAt` on the write-back below,
   * resetting the staleness clock on a tool set that was never re-listed —
   * so `staleness.maxAgeMs` could never fire on a repeatedly-rehydrated
   * snapshot. Age tracks when the tools were last actually discovered, not
   * when they were last replayed. `refresh()` clears it, because that path
   * does re-list.
   */
  replayedCachedAt?: number;
}

/**
 * Connect, discover tools via `listTools()`, and build a handle WITHOUT
 * consulting the cache for a hit. The cache (when present on `options`) is still
 * written through `makeHandle`, so refreshes persist. This is the cold cache-miss
 * path, and is also called directly by `rehydrateMCPTools`'s fallback: routing
 * the fallback here instead of back through `createMCPTools` is what prevents the
 * cache-fallback loop — re-reading the same snapshot would re-enter rehydrate and
 * recurse without bound.
 */
export async function freshConnect(
  options: CreateMCPToolsOptions,
  url: URL,
  cacheKey: string,
): Promise<MCPToolsHandle> {
  const connection = await connect({
    url,
    ...(options.transport !== undefined && {
      transport: options.transport,
    }),
    ...(options.auth !== undefined && {
      auth: options.auth,
    }),
    ...(options.fetch !== undefined && {
      fetch: options.fetch,
    }),
    ...(options.clientInfo !== undefined && {
      clientInfo: options.clientInfo,
    }),
    ...(options.onElicitation !== undefined && {
      onElicitation: options.onElicitation,
    }),
    ...(options.protocolNegotiation !== undefined && {
      protocolNegotiation: options.protocolNegotiation,
    }),
    ...(options.probeTimeoutMs !== undefined && {
      probeTimeoutMs: options.probeTimeoutMs,
    }),
    ...(options.signal !== undefined && {
      signal: options.signal,
    }),
  });

  // Tear the connection down if discovery or the initial cache write throws —
  // otherwise the open transport (HTTP keep-alive / SSE stream) leaks.
  try {
    const initialToolDefs = await listToolDefs(connection, options.signal);
    return await makeHandle({
      connection,
      options,
      context: {
        url,
        transport: connection.transport,
        cacheKey,
      },
      initialToolDefs,
    });
  } catch (err) {
    await closeQuietly(connection);
    throw err;
  }
}

/**
 * Construct an {@link MCPToolsHandle} around a live connection, wiring refresh,
 * serialize, list_changed listeners, and cache writes.
 */
export async function makeHandle(args: MakeHandleArgs): Promise<MCPToolsHandle> {
  const { connection, options, context, initialToolDefs } = args;
  const listeners = new Set<(tools: readonly Tool[]) => void>();
  let toolDefs = initialToolDefs;
  // Cleared by refresh(): once we have re-listed, age is measured from now.
  let replayedCachedAt = args.replayedCachedAt;
  const serverInfo = connection.client.getServerVersion();

  const rebuild = (): Tool[] => buildTools(buildToolsArgs(connection, toolDefs, options));

  let tools: readonly Tool[] = rebuild();

  const snapshot = (): Promise<SerializedMCPServer> =>
    serializeServer(
      serializeArgs({
        connection,
        context,
        toolDefs,
        serverInfo,
        options,
        ...(replayedCachedAt !== undefined && {
          cachedAt: replayedCachedAt,
        }),
      }),
    );

  const writeCache = async (): Promise<void> => {
    const store = options.cache?.store;
    if (store === undefined) {
      return;
    }
    // Built OUTSIDE the try: `snapshot()` can reject from the caller's own
    // OAuth provider (`provider.tokens()`), and relabelling that as a cache
    // write failure would send it down every "store outages are harmless"
    // path — swallowed by the list_changed handler, ignored by
    // `refreshStaleReplay`, and dismissed by callers following the documented
    // `MCPCacheWriteError` pattern. Only the store op earns the tag.
    const payload = await snapshot();
    try {
      await store.set(context.cacheKey, payload);
    } catch (writeErr) {
      // Tagged so callers can tell a store outage from a failed read. The two
      // look identical coming out of `refresh()` but mean opposite things: a
      // failed read leaves the tool set unknown, while a failed write leaves a
      // live connection with current tools and only a stale cache entry.
      throw new MCPCacheWriteError('Failed to write the MCP snapshot to the cache store', {
        cause: writeErr,
      });
    }
  };

  // INVARIANT internal callers rely on: `refresh()` swaps `tools` to a fresh
  // array (rebuild() always allocates) exactly when the re-list succeeded, and
  // it does so BEFORE attempting to persist. A caller that captured the old
  // reference can therefore tell "the re-list failed" (reference unchanged)
  // from "only something after the re-list failed" (reference changed) without
  // inspecting the error — which no error-class check can do reliably, since
  // persistence can fail outside the store op too (the caller's own OAuth
  // provider rejecting inside `snapshot()`).
  const refresh = async (): Promise<readonly Tool[]> => {
    toolDefs = await listToolDefs(connection, options.signal);
    // Re-listed, so the snapshot is genuinely current from here on.
    replayedCachedAt = undefined;
    tools = rebuild();
    await writeCache();
    return tools;
  };

  if (options.autoRefreshOnListChanged ?? true) {
    connection.setToolListChangedHandler(() => {
      // Fire-and-forget, but never let a failed refresh escape as an unhandled
      // rejection. Whether to announce is keyed on ADOPTION (the reference
      // swap above), not on error class: once `refresh()` has swapped `tools`,
      // skipping the announcement would leave subscribers permanently out of
      // sync with `handle.tools`, no matter what broke afterwards — a store
      // outage and an OAuth provider failing during serialize gate it equally
      // little. On a failed re-list the reference is untouched and subscribers
      // correctly keep the last good set.
      const before = tools;
      void refresh()
        .catch(() => undefined)
        .then(() => {
          if (tools === before) {
            return;
          }
          for (const listener of listeners) {
            listener(tools);
          }
        })
        .catch(() => {});
    });
  }

  // Skipped entirely on a replay: with `replayedCachedAt` carried forward the
  // snapshot we would write is the one just read — same tool defs, same
  // `cachedAt` — so the write is an external store round-trip per rehydrate
  // buying nothing. (It also cannot *refresh* anything: preserving the age is
  // the point.) A cold connect writes; `refresh()` clears `replayedCachedAt`
  // and writes. Skipping here additionally narrows DEV-766's surface — one
  // fewer path that can rewrite a credentialed entry under different options.
  //
  // Best-effort when it does run: the handle is fully usable without its cache
  // entry, so a store outage should not stop a connection that already
  // succeeded. `refresh()` reports write failures as `MCPCacheWriteError` for
  // callers that do care.
  if (args.replayedCachedAt === undefined) {
    await writeCache().catch(() => {});
  }

  return {
    get tools() {
      return tools;
    },
    ...(serverInfo !== undefined && {
      serverInfo,
    }),
    serialize: snapshot,
    refresh,
    onToolsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => connection.close(),
  };
}

/** Assemble the {@link buildTools} arguments, threading only the defined options. */
function buildToolsArgs(
  connection: MCPConnection,
  toolDefs: McpToolDef[],
  options: CreateMCPToolsOptions,
): BuildToolsOptions {
  return {
    client: connection.client,
    toolDefs,
    emitProgress: options.emitProgress ?? true,
    serverHasResources: serverHasResources(connection),
    ...(options.toolNamePrefix !== undefined && {
      namePrefix: options.toolNamePrefix,
    }),
    ...(options.includeTools !== undefined && {
      includeTools: options.includeTools,
    }),
    ...(options.excludeTools !== undefined && {
      excludeTools: options.excludeTools,
    }),
    ...(options.onUnconvertibleSchema !== undefined && {
      schemaMode: options.onUnconvertibleSchema,
    }),
    ...(options.signal !== undefined && {
      signal: options.signal,
    }),
    ...(options.loopKeys !== undefined && {
      loopKeys: options.loopKeys,
    }),
    ...(options.resources !== undefined && {
      resources: options.resources,
    }),
  };
}

interface SerializeArgsInput {
  connection: MCPConnection;
  context: HandleContext;
  toolDefs: McpToolDef[];
  serverInfo:
    | {
        name?: string;
        version?: string;
      }
    | undefined;
  options: CreateMCPToolsOptions;
  /** Carried forward on a snapshot replay; defaults to now on a cold connect. */
  cachedAt?: number;
}

/** Assemble the {@link serializeServer} input, threading only the defined fields. */
function serializeArgs(args: SerializeArgsInput): SerializeInput {
  const { connection, context, toolDefs, serverInfo, options } = args;
  return {
    url: context.url.href,
    transport: connection.transport,
    toolDefs,
    cacheCredentials: options.cacheCredentials ?? false,
    cachedAt: args.cachedAt ?? Date.now(),
    ...(serverInfo !== undefined && {
      serverInfo,
    }),
    ...(options.auth !== undefined && {
      auth: options.auth,
    }),
  };
}

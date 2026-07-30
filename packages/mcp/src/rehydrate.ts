import type { MCPAuth } from './auth/auth-types.js';
import type { MCPCacheStore } from './cache/cache-store.js';
import { defaultCacheKey } from './cache/cache-store.js';
import type { SerializedMCPServer } from './cache/cache-types.js';
import { isSerializedMCPServer } from './cache/cache-types.js';
import { closeQuietly } from './close-quietly.js';
import { MCPCacheError, MCPStaleSnapshotError } from './errors.js';
import { freshConnect, makeHandle } from './handle.js';
import type { ConnectOptions, MCPConnection } from './mcp-connection.js';
import { connect } from './mcp-connection.js';
import type { UnconvertibleSchemaMode } from './schema/json-schema-to-zod.js';
import type { McpToolDef } from './tool-wrapper.js';
import type {
  CreateMCPToolsOptions,
  ElicitationHandler,
  MCPProtocolNegotiation,
  MCPToolsHandle,
  ResourcesOption,
} from './types.js';

/** Clock skew (ms) treated as "already expired" when checking cached tokens. */
const EXPIRY_SKEW_MS = 30_000;

export interface RehydrateMCPToolsOptions {
  snapshot: SerializedMCPServer;
  /** Required when the snapshot carries no cached credentials. */
  auth?: MCPAuth;
  fetch?: typeof fetch;
  onUnconvertibleSchema?: UnconvertibleSchemaMode;
  onElicitation?: ElicitationHandler;
  signal?: AbortSignal;
  /** Protocol-revision negotiation policy; defaults to `'auto'`. */
  protocolNegotiation?: MCPProtocolNegotiation;
  /** Re-list tools instead of replaying a snapshot older than this. */
  staleness?: {
    maxAgeMs?: number;
  };
  /** Cache to refresh on reconnect/fallback. */
  cache?: {
    store: MCPCacheStore;
    key?: string;
  };
  /** On expiry / missing creds / connection failure, do a full reconnect. Default true. */
  reconnectOnExpiry?: boolean;
  // Tool-shaping + caching options threaded through from `createMCPTools` so a
  // cache hit applies the same filters/prefix as the original cold call.
  toolNamePrefix?: string;
  includeTools?: readonly string[];
  excludeTools?: readonly string[];
  resources?: ResourcesOption;
  emitProgress?: boolean;
  autoRefreshOnListChanged?: boolean;
  cacheCredentials?: boolean;
  clientInfo?: {
    name: string;
    version: string;
  };
}

function snapshotToToolDefs(snapshot: SerializedMCPServer): McpToolDef[] {
  return snapshot.tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined && {
      description: t.description,
    }),
    inputSchema: {
      ...t.inputSchema,
    },
    ...(t.outputSchema !== undefined && {
      outputSchema: {
        ...t.outputSchema,
      },
    }),
  }));
}

/** A snapshot older than `maxAgeMs` should be re-listed rather than replayed. */
function snapshotIsStale(snapshot: SerializedMCPServer, maxAgeMs: number | undefined): boolean {
  if (maxAgeMs === undefined) {
    return false;
  }
  return Date.now() - snapshot.cachedAt > maxAgeMs;
}

/** Cached tokens are unusable if they have a known expiry within the skew window. */
function tokensExpired(snapshot: SerializedMCPServer): boolean {
  const expiresAt = snapshot.auth?.tokens?.expiresAt;
  if (expiresAt === undefined) {
    return false;
  }
  return expiresAt - Date.now() <= EXPIRY_SKEW_MS;
}

/**
 * Reconstruct an {@link MCPAuth} from credentials persisted in a snapshot (only
 * present when it was serialized with `cacheCredentials: true`). Prefer static
 * headers when present; otherwise fall back to the OAuth/bearer access token.
 * Returns undefined when the snapshot carries no usable credentials.
 */
function authFromSnapshot(snapshot: SerializedMCPServer): MCPAuth | undefined {
  const auth = snapshot.auth;
  if (auth === undefined) {
    return undefined;
  }
  if (auth.headers !== undefined && Object.keys(auth.headers).length > 0) {
    return {
      kind: 'headers',
      headers: auth.headers,
    };
  }
  if (auth.tokens?.accessToken !== undefined) {
    return {
      kind: 'bearer',
      token: auth.tokens.accessToken,
    };
  }
  return undefined;
}

/**
 * Options copied straight from a rehydrate call onto the `createMCPTools`
 * options used for the fresh-connect fallback. `satisfies` keeps this honest:
 * a key that isn't on both types fails to compile rather than silently
 * dropping.
 *
 * `staleness` is deliberately absent — it compares a snapshot's age, and the
 * fallback path has no snapshot to compare.
 */
const PASS_THROUGH_CREATE_KEYS = [
  'fetch',
  'onUnconvertibleSchema',
  'onElicitation',
  'protocolNegotiation',
  'signal',
  'clientInfo',
  'toolNamePrefix',
  'includeTools',
  'excludeTools',
  'resources',
  'emitProgress',
  'autoRefreshOnListChanged',
  'cacheCredentials',
  'cache',
] as const satisfies readonly (keyof RehydrateMCPToolsOptions & keyof CreateMCPToolsOptions)[];

function toCreateOptions(
  options: RehydrateMCPToolsOptions,
  snapshot: SerializedMCPServer,
  effectiveAuth: MCPAuth | undefined,
): CreateMCPToolsOptions {
  const out: CreateMCPToolsOptions = {
    url: snapshot.url,
    transport: snapshot.transport,
    ...(effectiveAuth !== undefined && {
      auth: effectiveAuth,
    }),
  };
  // Copy every defined pass-through key in one pass. Written as a loop rather
  // than a spread per key so adding an option doesn't push this function's
  // cyclomatic complexity past the structural gate's ceiling; it also mirrors
  // `forwardedRehydrateOptions` in create-mcp-tools.ts, which forwards the same
  // set in the opposite direction.
  for (const key of PASS_THROUGH_CREATE_KEYS) {
    const value = options[key];
    if (value !== undefined) {
      Object.assign(out, {
        [key]: value,
      });
    }
  }
  return out;
}

/**
 * Connect options for the snapshot-replay path.
 *
 * Distinct from {@link toCreateOptions}, which builds the *fallback*
 * `createMCPTools` options: this one carries the snapshot's own `transport` and
 * `sessionId` because the point is to re-establish the connection the snapshot
 * describes, and it deliberately omits the tool-shaping keys, which are applied
 * by `makeHandle` rather than at connect time.
 */
function toReplayConnectOptions(args: {
  options: RehydrateMCPToolsOptions;
  snapshot: SerializedMCPServer;
  url: URL;
  effectiveAuth: MCPAuth | undefined;
}): ConnectOptions {
  const { options, snapshot, url, effectiveAuth } = args;
  return {
    url,
    transport: snapshot.transport,
    ...(effectiveAuth !== undefined && {
      auth: effectiveAuth,
    }),
    ...(options.fetch !== undefined && {
      fetch: options.fetch,
    }),
    ...(options.clientInfo !== undefined && {
      clientInfo: options.clientInfo,
    }),
    // `sessionId` is deliberately NOT forwarded. When a transport reports one,
    // SDK v2 skips negotiation entirely — no `server/discover` probe and no
    // `initialize` — and returns with `getProtocolEra()`,
    // `getServerCapabilities()` and `getServerVersion()` all left undefined. It
    // does not error, which is what makes it dangerous: `serverHasResources()`
    // reads those capabilities, so a snapshot carrying a `sessionId` would
    // silently replay with resource tools missing and no server info. Sessions
    // are also removed outright in 2026-07-28 (SEP-2567), so a fresh handshake
    // is both correct and cheap — one round trip on a path that already opens a
    // connection.
    ...(options.onElicitation !== undefined && {
      onElicitation: options.onElicitation,
    }),
    ...(options.protocolNegotiation !== undefined && {
      protocolNegotiation: options.protocolNegotiation,
    }),
  };
}

/**
 * Re-list tools on a handle built from a snapshot older than the caller's
 * `staleness.maxAgeMs`.
 *
 * Reached only when `reconnectOnExpiry` is false — otherwise a stale snapshot
 * has already gone to `freshConnect`. Re-listing over the connection just opened
 * honours `maxAgeMs` without the reconnect the caller declined: "stale" means the
 * tool set needs re-reading, not that the transport needs rebuilding.
 * `refresh()` also clears the carried `cachedAt`, so the write-back records the
 * new age rather than carrying the snapshot's forward.
 */
async function refreshStaleReplay(handle: MCPToolsHandle): Promise<void> {
  try {
    await handle.refresh();
  } catch (refreshErr) {
    // The connection is live and the snapshot's tools would work, but they are
    // older than the caller's own `maxAgeMs` — serving them anyway is exactly the
    // unbounded-age bug that check exists to prevent, so fail instead. Named
    // after staleness rather than reusing the generic rehydrate wording, because
    // the rehydrate itself succeeded and a reader chasing "failed to rehydrate"
    // would look in the wrong place.
    await closeQuietly(handle);
    throw new MCPStaleSnapshotError(
      'Snapshot is older than staleness.maxAgeMs and re-listing tools failed',
      {
        cause: refreshErr,
      },
    );
  }
}

/**
 * Rebuild an {@link MCPToolsHandle} from a cached snapshot. On the happy path we
 * reconnect the transport and rebuild tools directly from the snapshot —
 * skipping `listTools()`. If cached tokens are expired, credentials are missing,
 * or the connection fails, we transparently fall back to a full
 * {@link createMCPTools} (unless `reconnectOnExpiry` is false).
 */
export async function rehydrateMCPTools(
  options: RehydrateMCPToolsOptions,
): Promise<MCPToolsHandle> {
  const { snapshot } = options;
  if (!isSerializedMCPServer(snapshot)) {
    throw new MCPCacheError('Invalid MCP snapshot: failed structural validation');
  }

  const reconnectOnExpiry = options.reconnectOnExpiry ?? true;
  const url = new URL(snapshot.url);
  const cacheKey = options.cache?.key ?? defaultCacheKey(url.href);
  // Fall back to credentials cached in the snapshot when the caller didn't pass
  // any — otherwise a credential-bearing snapshot would reconnect unauthenticated.
  const effectiveAuth = options.auth ?? authFromSnapshot(snapshot);
  const hasCredentials = effectiveAuth !== undefined;
  // Route the fallback through `freshConnect`, NOT `createMCPTools`: the latter
  // would re-read this same snapshot and re-enter rehydrate, recursing without
  // bound on any no-credential / expired-token snapshot. `freshConnect` still
  // writes the refreshed result back to the cache via `makeHandle`.
  const createOptions = toCreateOptions(options, snapshot, effectiveAuth);

  // Staleness is checked here as well as in `createMCPTools`'s cache-hit path,
  // so a direct `rehydrateMCPTools()` call honours `staleness.maxAgeMs` too.
  // Previously only the `createMCPTools` route checked it, meaning callers who
  // held their own snapshot silently got unbounded-age tools.
  const staleSnapshot = snapshotIsStale(snapshot, options.staleness?.maxAgeMs);

  if ((tokensExpired(snapshot) || !hasCredentials || staleSnapshot) && reconnectOnExpiry) {
    return freshConnect(createOptions, url, cacheKey);
  }

  // Held outside the `try` so the `catch` can tear it down. `connect()` releases
  // its own client when it fails, so this stays undefined on that path and only
  // a post-connect failure has something to close.
  let connection: MCPConnection | undefined;
  try {
    connection = await connect(
      toReplayConnectOptions({
        options,
        snapshot,
        url,
        effectiveAuth,
      }),
    );

    // Rebuild tools from the snapshot — no listTools() round-trip.
    const handle = await makeHandle({
      connection,
      options: createOptions,
      context: {
        url,
        transport: connection.transport,
        cacheKey,
      },
      initialToolDefs: snapshotToToolDefs(snapshot),
      // Replay, not a listTools() — keep the snapshot's original age so
      // staleness.maxAgeMs stays measurable across repeated rehydrates.
      replayedCachedAt: snapshot.cachedAt,
    });

    if (staleSnapshot) {
      await refreshStaleReplay(handle);
    }

    return handle;
  } catch (err) {
    // The stale re-list above already closed and reported; let its verdict stand
    // rather than re-wrapping it as a generic rehydrate failure (and
    // double-closing). It is a deliberate refusal, not a rehydrate that broke.
    if (err instanceof MCPStaleSnapshotError) {
      throw err;
    }
    // Tear down the replay connection before leaving this path, mirroring
    // `freshConnect`'s guarantee in handle.ts. Whether we fall back (which opens
    // its own connection) or rethrow, nothing else holds a reference to this
    // one, so without the close its transport leaks. Reachable via `buildTools`
    // rejecting on a duplicate tool name, or a caller's `cache.store.set`
    // throwing during the initial write.
    if (connection !== undefined) {
      await closeQuietly(connection);
    }
    if (reconnectOnExpiry) {
      return freshConnect(createOptions, url, cacheKey);
    }
    throw new MCPCacheError('Failed to rehydrate MCP connection from snapshot', {
      cause: err,
    });
  }
}

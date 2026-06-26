import type { MCPAuth } from './auth/auth-types.js';
import type { MCPCacheStore } from './cache/cache-store.js';
import { defaultCacheKey } from './cache/cache-store.js';
import type { SerializedMCPServer } from './cache/cache-types.js';
import { isSerializedMCPServer } from './cache/cache-types.js';
import { MCPCacheError } from './errors.js';
import { freshConnect, makeHandle } from './handle.js';
import { connect } from './mcp-connection.js';
import type { UnconvertibleSchemaMode } from './schema/json-schema-to-zod.js';
import type { McpToolDef } from './tool-wrapper.js';
import type {
  CreateMCPToolsOptions,
  ElicitationHandler,
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

function toCreateOptions(
  options: RehydrateMCPToolsOptions,
  snapshot: SerializedMCPServer,
  effectiveAuth: MCPAuth | undefined,
): CreateMCPToolsOptions {
  return {
    url: snapshot.url,
    transport: snapshot.transport,
    ...(effectiveAuth !== undefined && {
      auth: effectiveAuth,
    }),
    ...(options.fetch !== undefined && {
      fetch: options.fetch,
    }),
    ...(options.onUnconvertibleSchema !== undefined && {
      onUnconvertibleSchema: options.onUnconvertibleSchema,
    }),
    ...(options.onElicitation !== undefined && {
      onElicitation: options.onElicitation,
    }),
    ...(options.signal !== undefined && {
      signal: options.signal,
    }),
    ...(options.clientInfo !== undefined && {
      clientInfo: options.clientInfo,
    }),
    ...(options.toolNamePrefix !== undefined && {
      toolNamePrefix: options.toolNamePrefix,
    }),
    ...(options.includeTools !== undefined && {
      includeTools: options.includeTools,
    }),
    ...(options.excludeTools !== undefined && {
      excludeTools: options.excludeTools,
    }),
    ...(options.resources !== undefined && {
      resources: options.resources,
    }),
    ...(options.emitProgress !== undefined && {
      emitProgress: options.emitProgress,
    }),
    ...(options.autoRefreshOnListChanged !== undefined && {
      autoRefreshOnListChanged: options.autoRefreshOnListChanged,
    }),
    ...(options.cacheCredentials !== undefined && {
      cacheCredentials: options.cacheCredentials,
    }),
    ...(options.cache !== undefined && {
      cache: options.cache,
    }),
  };
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

  if ((tokensExpired(snapshot) || !hasCredentials) && reconnectOnExpiry) {
    return freshConnect(createOptions, url, cacheKey);
  }

  try {
    const connection = await connect({
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
      ...(snapshot.sessionId !== undefined && {
        sessionId: snapshot.sessionId,
      }),
      ...(options.onElicitation !== undefined && {
        onElicitation: options.onElicitation,
      }),
    });

    // Rebuild tools from the snapshot — no listTools() round-trip.
    return makeHandle({
      connection,
      options: createOptions,
      context: {
        url,
        transport: connection.transport,
        cacheKey,
      },
      initialToolDefs: snapshotToToolDefs(snapshot),
    });
  } catch (err) {
    if (reconnectOnExpiry) {
      return freshConnect(createOptions, url, cacheKey);
    }
    throw new MCPCacheError('Failed to rehydrate MCP connection from snapshot', {
      cause: err,
    });
  }
}

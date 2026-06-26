import type { MCPAuth } from './auth/auth-types.js';
import type { MCPCacheStore } from './cache/cache-store.js';
import { defaultCacheKey } from './cache/cache-store.js';
import type { SerializedMCPServer } from './cache/cache-types.js';
import { isSerializedMCPServer } from './cache/cache-types.js';
import { createMCPTools, makeHandle } from './create-mcp-tools.js';
import { MCPCacheError } from './errors.js';
import { connect } from './mcp-connection.js';
import type { UnconvertibleSchemaMode } from './schema/json-schema-to-zod.js';
import type { McpToolDef } from './tool-wrapper.js';
import type { CreateMCPToolsOptions, ElicitationHandler, MCPToolsHandle } from './types.js';

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

function toCreateOptions(
  options: RehydrateMCPToolsOptions,
  snapshot: SerializedMCPServer,
): CreateMCPToolsOptions {
  return {
    url: snapshot.url,
    transport: snapshot.transport,
    ...(options.auth !== undefined && {
      auth: options.auth,
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
  const hasCredentials = options.auth !== undefined || snapshot.auth !== undefined;

  if ((tokensExpired(snapshot) || !hasCredentials) && reconnectOnExpiry) {
    return createMCPTools(toCreateOptions(options, snapshot));
  }

  try {
    const connection = await connect({
      url,
      transport: snapshot.transport,
      ...(options.auth !== undefined && {
        auth: options.auth,
      }),
      ...(options.fetch !== undefined && {
        fetch: options.fetch,
      }),
      ...(snapshot.sessionId !== undefined && {
        sessionId: snapshot.sessionId,
      }),
      ...(options.onElicitation !== undefined && {
        onElicitation: options.onElicitation,
      }),
    });

    const createOptions = toCreateOptions(options, snapshot);
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
      return createMCPTools(toCreateOptions(options, snapshot));
    }
    throw new MCPCacheError('Failed to rehydrate MCP connection from snapshot', {
      cause: err,
    });
  }
}

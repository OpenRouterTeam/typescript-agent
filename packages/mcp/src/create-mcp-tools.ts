import type { Tool } from '@openrouter/agent';
import { buildTools } from './build-tools.js';
import type { MCPCacheStore } from './cache/cache-store.js';
import { defaultCacheKey } from './cache/cache-store.js';
import type { SerializedMCPServer } from './cache/cache-types.js';
import { isSerializedMCPServer } from './cache/cache-types.js';
import { serializeServer } from './cache/serialize.js';
import type { MCPConnection } from './mcp-connection.js';
import { connect } from './mcp-connection.js';
import type { McpToolDef } from './tool-wrapper.js';
import type { CreateMCPToolsOptions, MCPToolsHandle, MCPTransportKind } from './types.js';

function normalizeUrl(url: string | URL): URL {
  return url instanceof URL ? url : new URL(url);
}

/** Read the discovered tools off the live connection into our internal shape. */
async function listToolDefs(
  connection: MCPConnection,
  signal: AbortSignal | undefined,
): Promise<McpToolDef[]> {
  const requestOptions =
    signal !== undefined
      ? {
          signal,
        }
      : undefined;
  const { tools } = await connection.client.listTools(undefined, requestOptions);
  return tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined && {
      description: t.description,
    }),
    inputSchema: t.inputSchema,
    ...(t.outputSchema !== undefined && {
      outputSchema: t.outputSchema,
    }),
  }));
}

function serverHasResources(connection: MCPConnection): boolean {
  const caps = connection.client.getServerCapabilities();
  return caps?.resources !== undefined;
}

/**
 * Connect to a remote MCP server, discover its tools, and return a handle whose
 * `.tools` can be passed straight into `callModel({ tools })`. Auth is supplied
 * once and reused for discovery and every subsequent tool call.
 *
 * When `cache` is provided, a valid non-stale snapshot is rehydrated instead of
 * re-listing; otherwise the fresh result is written back to the cache.
 */
export async function createMCPTools(options: CreateMCPToolsOptions): Promise<MCPToolsHandle> {
  const url = normalizeUrl(options.url);
  const cacheKey = options.cache?.key ?? defaultCacheKey(url.href);

  if (options.cache !== undefined) {
    const hit = await tryCacheHit(options, options.cache.store, cacheKey);
    if (hit !== undefined) {
      return hit;
    }
  }

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
  });

  const initialToolDefs = await listToolDefs(connection, options.signal);
  return makeHandle({
    connection,
    options,
    context: {
      url,
      transport: connection.transport,
      cacheKey,
    },
    initialToolDefs,
  });
}

async function tryCacheHit(
  options: CreateMCPToolsOptions,
  store: MCPCacheStore,
  cacheKey: string,
): Promise<MCPToolsHandle | undefined> {
  const snapshot = await store.get(cacheKey);
  if (snapshot === null || snapshot === undefined || !isSerializedMCPServer(snapshot)) {
    return undefined;
  }
  const maxAge = options.staleness?.maxAgeMs;
  if (maxAge !== undefined && Date.now() - snapshot.cachedAt > maxAge) {
    return undefined;
  }
  // Defer to rehydrate, which reconnects and falls back to a fresh connect on
  // expiry. Imported lazily to avoid a circular module dependency.
  const { rehydrateMCPTools } = await import('./rehydrate.js');
  return rehydrateMCPTools({
    snapshot,
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
    cache: {
      store,
      key: cacheKey,
    },
  });
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
}

/**
 * Construct an {@link MCPToolsHandle} around a live connection, wiring refresh,
 * serialize, list_changed listeners, and cache writes.
 */
export async function makeHandle(args: MakeHandleArgs): Promise<MCPToolsHandle> {
  const { connection, options, context, initialToolDefs } = args;
  const listeners = new Set<(tools: readonly Tool[]) => void>();
  let toolDefs = initialToolDefs;
  const serverInfo = connection.client.getServerVersion();

  const rebuild = (): Tool[] =>
    buildTools({
      client: connection.client,
      toolDefs,
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
      emitProgress: options.emitProgress ?? true,
      ...(options.signal !== undefined && {
        signal: options.signal,
      }),
      ...(options.resources !== undefined && {
        resources: options.resources,
      }),
      serverHasResources: serverHasResources(connection),
    });

  let tools: readonly Tool[] = rebuild();

  const writeCache = async (): Promise<void> => {
    const store = options.cache?.store;
    if (store === undefined) {
      return;
    }
    const snapshot = await serializeServer({
      url: context.url.href,
      transport: connection.transport,
      toolDefs,
      ...(serverInfo !== undefined && {
        serverInfo,
      }),
      ...(connection.sessionId !== undefined && {
        sessionId: connection.sessionId,
      }),
      ...(options.auth !== undefined && {
        auth: options.auth,
      }),
      cacheCredentials: options.cacheCredentials ?? false,
      cachedAt: Date.now(),
    });
    await store.set(context.cacheKey, snapshot);
  };

  const refresh = async (): Promise<readonly Tool[]> => {
    toolDefs = await listToolDefs(connection, options.signal);
    tools = rebuild();
    await writeCache();
    return tools;
  };

  if (options.autoRefreshOnListChanged ?? true) {
    connection.setToolListChangedHandler(() => {
      void refresh().then(() => {
        for (const listener of listeners) {
          listener(tools);
        }
      });
    });
  }

  await writeCache();

  return {
    get tools() {
      return tools;
    },
    ...(serverInfo !== undefined && {
      serverInfo,
    }),
    serialize: () =>
      serializeServer({
        url: context.url.href,
        transport: connection.transport,
        toolDefs,
        ...(serverInfo !== undefined && {
          serverInfo,
        }),
        ...(connection.sessionId !== undefined && {
          sessionId: connection.sessionId,
        }),
        ...(options.auth !== undefined && {
          auth: options.auth,
        }),
        cacheCredentials: options.cacheCredentials ?? false,
        cachedAt: Date.now(),
      }),
    refresh,
    onToolsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => connection.close(),
  };
}

export type { SerializedMCPServer };

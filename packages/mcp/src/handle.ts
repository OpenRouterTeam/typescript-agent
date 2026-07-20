import type { Tool } from '@openrouter/agent/tool-types';
import type { BuildToolsOptions } from './build-tools.js';
import { buildTools } from './build-tools.js';
import type { SerializedMCPServer } from './cache/cache-types.js';
import type { SerializeInput } from './cache/serialize.js';
import { serializeServer } from './cache/serialize.js';
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
 * Read the discovered tools off the live connection into our internal shape.
 *
 * `tools/list` is paginated: each response may carry a `nextCursor` that must be
 * passed back as `{ cursor }` to fetch the next page. We accumulate every page so
 * servers that paginate their tool list aren't silently truncated.
 */
export async function listToolDefs(
  connection: MCPConnection,
  signal: AbortSignal | undefined,
): Promise<McpToolDef[]> {
  const requestOptions =
    signal !== undefined
      ? {
          signal,
        }
      : undefined;
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
      collected.push({
        name: t.name,
        ...(t.description !== undefined && {
          description: t.description,
        }),
        inputSchema: t.inputSchema,
        ...(t.outputSchema !== undefined && {
          outputSchema: t.outputSchema,
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
    await connection.close().catch(() => {});
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
      }),
    );

  const writeCache = async (): Promise<void> => {
    const store = options.cache?.store;
    if (store === undefined) {
      return;
    }
    await store.set(context.cacheKey, await snapshot());
  };

  const refresh = async (): Promise<readonly Tool[]> => {
    toolDefs = await listToolDefs(connection, options.signal);
    tools = rebuild();
    await writeCache();
    return tools;
  };

  if (options.autoRefreshOnListChanged ?? true) {
    connection.setToolListChangedHandler(() => {
      // Fire-and-forget, but never let a failed refresh escape as an unhandled
      // rejection. On failure listeners keep the last good tool set.
      void refresh()
        .then((next) => {
          for (const listener of listeners) {
            listener(next);
          }
        })
        .catch(() => {});
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
}

/** Assemble the {@link serializeServer} input, threading only the defined fields. */
function serializeArgs(args: SerializeArgsInput): SerializeInput {
  const { connection, context, toolDefs, serverInfo, options } = args;
  return {
    url: context.url.href,
    transport: connection.transport,
    toolDefs,
    cacheCredentials: options.cacheCredentials ?? false,
    cachedAt: Date.now(),
    ...(serverInfo !== undefined && {
      serverInfo,
    }),
    ...(connection.sessionId !== undefined && {
      sessionId: connection.sessionId,
    }),
    ...(options.auth !== undefined && {
      auth: options.auth,
    }),
  };
}

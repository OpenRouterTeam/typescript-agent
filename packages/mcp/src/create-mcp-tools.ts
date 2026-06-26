import type { MCPCacheStore } from './cache/cache-store.js';
import { defaultCacheKey } from './cache/cache-store.js';
import type { SerializedMCPServer } from './cache/cache-types.js';
import { isSerializedMCPServer } from './cache/cache-types.js';
import { freshConnect, normalizeUrl } from './handle.js';
import type { RehydrateMCPToolsOptions } from './rehydrate.js';
import { rehydrateMCPTools } from './rehydrate.js';
import type { CreateMCPToolsOptions, MCPToolsHandle } from './types.js';

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

  return freshConnect(options, url, cacheKey);
}

// Option keys forwarded verbatim from a cache-hit `createMCPTools` call into
// `rehydrateMCPTools`, so a warm handle applies the same auth, filters, prefix,
// and credential-caching behavior as a cold one.
const FORWARDED_REHYDRATE_KEYS = [
  'auth',
  'fetch',
  'clientInfo',
  'onUnconvertibleSchema',
  'onElicitation',
  'signal',
  'toolNamePrefix',
  'includeTools',
  'excludeTools',
  'resources',
  'emitProgress',
  'autoRefreshOnListChanged',
  'cacheCredentials',
] as const satisfies readonly (keyof CreateMCPToolsOptions & keyof RehydrateMCPToolsOptions)[];

/** Copy the defined forwarded options from `createMCPTools` into a rehydrate base. */
function forwardedRehydrateOptions(
  options: CreateMCPToolsOptions,
): Partial<RehydrateMCPToolsOptions> {
  const out: Partial<RehydrateMCPToolsOptions> = {};
  for (const key of FORWARDED_REHYDRATE_KEYS) {
    const value = options[key];
    if (value !== undefined) {
      Object.assign(out, {
        [key]: value,
      });
    }
  }
  return out;
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
  // expiry.
  return rehydrateMCPTools({
    snapshot,
    ...forwardedRehydrateOptions(options),
    cache: {
      store,
      key: cacheKey,
    },
  });
}

export type { SerializedMCPServer };

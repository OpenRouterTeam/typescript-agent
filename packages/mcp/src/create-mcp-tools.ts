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
// loop identities, and credential-caching behavior as a cold one. Anything
// omitted here is SILENTLY DROPPED on a cache hit — when adding an option to
// `CreateMCPToolsOptions` that rehydrate also honors, add it here too.
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
  'loopKeys',
  'autoRefreshOnListChanged',
  'cacheCredentials',
  'protocolNegotiation',
  'probeTimeoutMs',
  'staleness',
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
  // A failed read is a miss, not a failure. The cache exists to skip a
  // listTools() round trip; a store blip on the lookup must not reject a call
  // that a plain miss would have served via a fresh connect. This mirrors the
  // write side, which is best-effort everywhere — without it, "a store outage
  // leaves you with a working handle" only held if the outage arrived after
  // the read. Wrapped in try/catch rather than `.catch()`: `MCPCacheStore.get`
  // may return synchronously, and a synchronous throw would bypass a
  // promise-level handler — the exact hole `closeQuietly` exists to plug on
  // the teardown side.
  let snapshot: Awaited<ReturnType<MCPCacheStore['get']>> | undefined;
  try {
    snapshot = await store.get(cacheKey);
  } catch {
    snapshot = undefined;
  }
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

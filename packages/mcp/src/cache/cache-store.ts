import type { SerializedMCPServer } from './cache-types.js';

/**
 * Pluggable cache for MCP server snapshots. Implement this to back the cache
 * with Redis, a database, or the filesystem. All methods may be async.
 *
 * SECURITY: when `cacheCredentials` is enabled, stored snapshots contain bearer
 * tokens/headers — treat the store as a secret store (encrypt at rest, scope
 * access) and namespace keys by principal in multi-tenant setups.
 */
export interface MCPCacheStore {
  get(key: string): Promise<SerializedMCPServer | null> | SerializedMCPServer | null;
  set(key: string, value: SerializedMCPServer): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
}

/** Default in-process cache backed by a `Map`. Not shared across processes. */
export class InMemoryMCPCacheStore implements MCPCacheStore {
  private readonly entries = new Map<string, SerializedMCPServer>();

  get(key: string): SerializedMCPServer | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: SerializedMCPServer): void {
    this.entries.set(key, value);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

/** Default cache key for a server URL. Override via `cache.key` for multi-tenant. */
export function defaultCacheKey(url: string): string {
  return `openrouter-mcp:${url}`;
}

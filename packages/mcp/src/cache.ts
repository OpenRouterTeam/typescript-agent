// Thin compatibility wrapper: re-exports the "cache" subpath from
// @openrouter/agent/mcp so `@openrouter/mcp/cache` keeps working.
export type { MCPCacheStore } from '@openrouter/agent/mcp/cache';
export { defaultCacheKey, InMemoryMCPCacheStore } from '@openrouter/agent/mcp/cache';

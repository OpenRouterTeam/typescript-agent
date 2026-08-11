import * as agentCache from '@openrouter/agent/mcp/cache';
import { describe, expect, it } from 'vitest';
import * as wrapperCache from '../../src/cache.js';

describe('@openrouter/mcp/cache export parity', () => {
  it('exports exactly the same runtime binding names as @openrouter/agent/mcp/cache', () => {
    const agentKeys = Object.keys(agentCache).sort();
    const wrapperKeys = Object.keys(wrapperCache).sort();
    expect(wrapperKeys).toEqual(agentKeys);
  });

  it('re-exports the exact same bindings by reference', () => {
    for (const key of Object.keys(wrapperCache)) {
      expect((wrapperCache as Record<string, unknown>)[key]).toBe(
        (agentCache as Record<string, unknown>)[key],
      );
    }
  });

  it('defaultCacheKey and InMemoryMCPCacheStore behave as expected', () => {
    expect(wrapperCache.defaultCacheKey('https://example.com')).toBe(
      'openrouter-mcp:https://example.com',
    );
    const store = new wrapperCache.InMemoryMCPCacheStore();
    expect(store.get('missing')).toBeNull();
  });
});

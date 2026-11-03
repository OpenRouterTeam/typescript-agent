---
'@openrouter/agent': patch
---

MCP cache entries are now only reused for the server URL they were written for. When a custom `cache.key` holds an entry for a different URL, `createMCPTools` treats it as a cache miss and connects to the requested URL, replacing the entry. Credential maintenance on replay likewise leaves entries for other URLs untouched.

```ts
import { createMCPTools, InMemoryMCPCacheStore } from '@openrouter/agent/mcp';

const store = new InMemoryMCPCacheStore();

// Writes an entry for server A under the user's key.
await createMCPTools({ url: 'https://a.example.com/mcp', auth: authA, cache: { store, key: 'mcp:user-123' } });

// Same key, different server. Before: replayed A's cached entry.
// Now: a cache miss — connects to B and replaces the entry with B's tools.
await createMCPTools({ url: 'https://b.example.com/mcp', auth: authB, cache: { store, key: 'mcp:user-123' } });

// Recommended: include the server URL so each server keeps its own entry.
const url = 'https://b.example.com/mcp';
await createMCPTools({ url, auth: authB, cache: { store, key: `mcp:user-123:${url}` } });
```

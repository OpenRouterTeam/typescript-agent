---
'@openrouter/agent': patch
---

MCP cache entries are now only reused for the server URL they were written for. When a custom `cache.key` holds an entry for a different URL, `createMCPTools` treats it as a cache miss and connects to the requested URL, replacing the entry. Credential maintenance on replay likewise leaves entries for other URLs untouched.

---
'@openrouter/mcp': patch
---

Raise the `@modelcontextprotocol/client` dependency to `^2.2.0`, matching the new peer floor of `@openrouter/agent`. With SDK 2.0.0 or 2.1.0, closing a handle while its `tools/list_changed` subscription is still being opened can exit the process with an unhandled rejection.

---
'@openrouter/agent': patch
---

`callModel` now throws when two client tools in `tools` share a name. Tool calls are dispatched by name, so with a duplicate the first tool in the list received the call, including a call that was approved while a different tool with that name was registered. Rename one of the tools, or pass `toolNamePrefix` to `createMCPTools` when combining MCP tools with local tools.

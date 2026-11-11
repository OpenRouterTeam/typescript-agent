---
'@openrouter/agent': patch
---

Fix MCP tool calls being rejected, or wrongly accepted, when the server's input schema has `oneOf`/`anyOf`/`allOf` branches with no `type`.

JSON Schema lets a branch omit the `type` its enclosing schema already states, as in `{ "type": "object", "oneOf": [{ "required": ["id"], ... }, { "required": ["image"], ... }] }`. The Zod conversion read such a branch as "any value", so a `oneOf` of them rejected every call ("Invalid input") and an `anyOf` of them accepted calls the server would refuse. Shopify's catalog `search_catalog` tool is one example: every `catalog.like` call failed validation before reaching the server.

The conversion now works on a copy of the schema in which each branch states the type its enclosing schema requires, and a branch that only names a required key carries the enclosing description of that key. The server's schema is not modified, and the model still receives it as written.

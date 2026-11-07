---
'@openrouter/agent': minor
---

Send an MCP tool's own JSON Schema to the model instead of one regenerated from Zod.

`wrapMcpTool` converts the server's `inputSchema` to Zod to validate call arguments, and the model-facing `parameters` were then regenerated from that Zod schema. The round trip rewrote the schema: every string `format` gained a `pattern` (about 400 characters for `date-time`), every `integer` gained safe-integer bounds, `$ref`/`$defs` were inlined, and open objects gained `additionalProperties: {}`.

MCP tools now keep both. The server's schema is stored as `function.wireInputSchema` and serialized verbatim (sanitized of `~`-prefixed keys); the Zod `inputSchema` still validates the call. `wireInputSchema` moves from `ManualToolFunction` to `BaseToolFunction`, and `markMcp` accepts it as an option. A server schema whose root is not an object still serializes the Zod-derived object schema.

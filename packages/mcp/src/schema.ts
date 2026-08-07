// Thin compatibility wrapper: re-exports the "schema" subpath from
// @openrouter/agent/mcp so `@openrouter/mcp/schema` keeps working.
export type { UnconvertibleSchemaMode } from '@openrouter/agent/mcp/schema';
export { convertMcpInputSchema } from '@openrouter/agent/mcp/schema';

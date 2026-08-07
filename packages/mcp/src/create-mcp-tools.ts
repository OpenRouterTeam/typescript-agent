// Thin compatibility wrapper: re-exports the "create-mcp-tools" subpath from
// @openrouter/agent/mcp so `@openrouter/mcp/create-mcp-tools` keeps working.

export type { SerializedMCPServer } from '@openrouter/agent/mcp/create-mcp-tools';
export { createMCPTools } from '@openrouter/agent/mcp/create-mcp-tools';

// Thin compatibility wrapper: re-exports the "types" subpath from
// @openrouter/agent/mcp so `@openrouter/mcp/types` keeps working.
export type {
  CreateMCPToolsOptions,
  ElicitationHandler,
  ElicitationResponse,
  MCPToolsHandle,
  MCPTransportKind,
  ResourcesOption,
} from '@openrouter/agent/mcp/types';

// Thin compatibility wrapper: @openrouter/mcp re-exports the canonical
// implementation that now lives in @openrouter/agent/mcp. This file exists so
// existing consumers importing from "@openrouter/mcp" keep working unchanged.
export type {
  CreateMCPToolsOptions,
  ElicitationHandler,
  ElicitationResponse,
  MCPAuth,
  MCPCacheStore,
  MCPToolsHandle,
  MCPTransportKind,
  RehydrateMCPToolsOptions,
  ResourcesOption,
  SerializedMCPServer,
  SerializedMCPToolDef,
  SerializedTokenSet,
  UnconvertibleSchemaMode,
} from '@openrouter/agent/mcp';
export {
  convertMcpInputSchema,
  createMCPTools,
  defaultCacheKey,
  InMemoryMCPCacheStore,
  isSerializedMCPServer,
  MCPCacheError,
  MCPConnectionError,
  MCPError,
  MCPToolCallError,
  rehydrateMCPTools,
} from '@openrouter/agent/mcp';

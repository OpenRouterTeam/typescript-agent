/**
 * Compatibility facade for the canonical `@openrouter/agent/mcp` integration.
 *
 * @deprecated Import from `@openrouter/agent/mcp` instead. This facade remains
 * available for migration and may be removed only in a future breaking release.
 */
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
  MCPMissingPeerDependencyError,
  MCPToolCallError,
  rehydrateMCPTools,
} from '@openrouter/agent/mcp';

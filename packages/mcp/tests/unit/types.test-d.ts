import type {
  CreateMCPToolsOptions as AgentCreateMCPToolsOptions,
  ElicitationHandler as AgentElicitationHandler,
  ElicitationResponse as AgentElicitationResponse,
  MCPProtocolNegotiation as AgentMCPProtocolNegotiation,
  MCPProtocolRevision as AgentMCPProtocolRevision,
  MCPToolsHandle as AgentMCPToolsHandle,
  MCPTransportKind as AgentMCPTransportKind,
  ResourcesOption as AgentResourcesOption,
} from '@openrouter/agent/mcp/types';
import type {
  CreateMCPToolsOptions,
  ElicitationHandler,
  ElicitationResponse,
  MCPProtocolNegotiation,
  MCPProtocolRevision,
  MCPToolsHandle,
  MCPTransportKind,
  ResourcesOption,
} from '@openrouter/mcp/types';
import { expectTypeOf } from 'vitest';

expectTypeOf<CreateMCPToolsOptions>().toEqualTypeOf<AgentCreateMCPToolsOptions>();
expectTypeOf<MCPToolsHandle>().toEqualTypeOf<AgentMCPToolsHandle>();
expectTypeOf<ElicitationHandler>().toEqualTypeOf<AgentElicitationHandler>();
expectTypeOf<ElicitationResponse>().toEqualTypeOf<AgentElicitationResponse>();
expectTypeOf<ResourcesOption>().toEqualTypeOf<AgentResourcesOption>();
expectTypeOf<MCPProtocolNegotiation>().toEqualTypeOf<AgentMCPProtocolNegotiation>();
expectTypeOf<MCPProtocolRevision>().toEqualTypeOf<AgentMCPProtocolRevision>();
expectTypeOf<MCPTransportKind>().toEqualTypeOf<AgentMCPTransportKind>();

import type * as AgentTypes from '@openrouter/agent/mcp/types';
import type * as WrapperTypes from '@openrouter/mcp/types';
import { describe, expectTypeOf, it } from 'vitest';

// `@openrouter/mcp/types` is type-only, so parity is verified structurally at
// the type level rather than via runtime `Object.keys` (there is nothing to
// inspect at runtime for a type-only module).
describe('@openrouter/mcp/types export parity (type-level)', () => {
  it('CreateMCPToolsOptions is structurally identical', () => {
    expectTypeOf<WrapperTypes.CreateMCPToolsOptions>().toEqualTypeOf<AgentTypes.CreateMCPToolsOptions>();
  });

  it('MCPToolsHandle is structurally identical', () => {
    expectTypeOf<WrapperTypes.MCPToolsHandle>().toEqualTypeOf<AgentTypes.MCPToolsHandle>();
  });

  it('ElicitationHandler is structurally identical', () => {
    expectTypeOf<WrapperTypes.ElicitationHandler>().toEqualTypeOf<AgentTypes.ElicitationHandler>();
  });

  it('ElicitationResponse is structurally identical', () => {
    expectTypeOf<WrapperTypes.ElicitationResponse>().toEqualTypeOf<AgentTypes.ElicitationResponse>();
  });

  it('ResourcesOption is structurally identical', () => {
    expectTypeOf<WrapperTypes.ResourcesOption>().toEqualTypeOf<AgentTypes.ResourcesOption>();
  });

  it('MCPTransportKind is structurally identical', () => {
    expectTypeOf<WrapperTypes.MCPTransportKind>().toEqualTypeOf<AgentTypes.MCPTransportKind>();
  });
});

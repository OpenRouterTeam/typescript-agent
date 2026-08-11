import * as agentCreateMcpTools from '@openrouter/agent/mcp/create-mcp-tools';
import { describe, expect, it } from 'vitest';
import * as wrapperCreateMcpTools from '../../src/create-mcp-tools.js';

describe('@openrouter/mcp/create-mcp-tools export parity', () => {
  it('exports exactly the same runtime binding names as @openrouter/agent/mcp/create-mcp-tools', () => {
    const agentKeys = Object.keys(agentCreateMcpTools).sort();
    const wrapperKeys = Object.keys(wrapperCreateMcpTools).sort();
    expect(wrapperKeys).toEqual(agentKeys);
  });

  it('re-exports the exact same bindings by reference', () => {
    for (const key of Object.keys(wrapperCreateMcpTools)) {
      expect((wrapperCreateMcpTools as Record<string, unknown>)[key]).toBe(
        (agentCreateMcpTools as Record<string, unknown>)[key],
      );
    }
  });

  it('exposes createMCPTools as a function', () => {
    expect(typeof wrapperCreateMcpTools.createMCPTools).toBe('function');
  });
});

import * as agentSchema from '@openrouter/agent/mcp/schema';
import { describe, expect, it } from 'vitest';
import * as wrapperSchema from '../../src/schema.js';

describe('@openrouter/mcp/schema export parity', () => {
  it('exports exactly the same runtime binding names as @openrouter/agent/mcp/schema', () => {
    const agentKeys = Object.keys(agentSchema).sort();
    const wrapperKeys = Object.keys(wrapperSchema).sort();
    expect(wrapperKeys).toEqual(agentKeys);
  });

  it('re-exports the exact same bindings by reference', () => {
    for (const key of Object.keys(wrapperSchema)) {
      expect((wrapperSchema as Record<string, unknown>)[key]).toBe(
        (agentSchema as Record<string, unknown>)[key],
      );
    }
  });

  it('exposes convertMcpInputSchema as a function', () => {
    expect(typeof wrapperSchema.convertMcpInputSchema).toBe('function');
  });
});

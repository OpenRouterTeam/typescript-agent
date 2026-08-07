import * as agentMcp from '@openrouter/agent/mcp';
import * as wrapperMcp from '@openrouter/mcp';
import { describe, expect, it } from 'vitest';

// Compatibility/export-parity tests: @openrouter/mcp is a thin wrapper that
// re-exports @openrouter/agent/mcp. These tests verify the wrapper's runtime
// exports are the SAME bindings as the canonical implementation (not a
// reimplementation) — the underlying MCP logic itself is tested exhaustively
// in packages/agent's own test suite.

describe('@openrouter/mcp root export parity with @openrouter/agent/mcp', () => {
  it('exports exactly the same runtime binding names', () => {
    const agentKeys = Object.keys(agentMcp).sort();
    const wrapperKeys = Object.keys(wrapperMcp).sort();
    expect(wrapperKeys).toEqual(agentKeys);
  });

  it('re-exports the exact same bindings by reference (not reimplementations)', () => {
    for (const key of Object.keys(wrapperMcp)) {
      expect((wrapperMcp as Record<string, unknown>)[key]).toBe(
        (agentMcp as Record<string, unknown>)[key],
      );
    }
  });
});

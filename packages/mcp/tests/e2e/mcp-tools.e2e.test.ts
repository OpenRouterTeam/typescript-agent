import { describe, expect, it } from 'vitest';
import { createMCPTools, InMemoryMCPCacheStore, rehydrateMCPTools } from '../../src/index.js';

// These tests require a reachable remote MCP server. Set MCP_TEST_URL (and
// optionally MCP_TEST_TOKEN) to run them; otherwise they are skipped.
const MCP_TEST_URL = process.env.MCP_TEST_URL;
const MCP_TEST_TOKEN = process.env.MCP_TEST_TOKEN;

const maybe = MCP_TEST_URL !== undefined ? describe : describe.skip;

// Resolved to a concrete string for the guarded block; the empty fallback is
// never reached because `maybe` is `describe.skip` when the URL is absent.
const url = MCP_TEST_URL ?? '';

maybe('createMCPTools (e2e)', () => {
  const auth =
    MCP_TEST_TOKEN !== undefined
      ? ({
          kind: 'bearer',
          token: MCP_TEST_TOKEN,
        } as const)
      : undefined;

  it('connects, lists tools, and exposes them for callModel', async () => {
    const mcp = await createMCPTools({
      url,
      ...(auth !== undefined && {
        auth,
      }),
    });
    try {
      expect(mcp.tools.length).toBeGreaterThan(0);
      // Each wrapped tool carries a function name usable by callModel.
      for (const t of mcp.tools) {
        expect('function' in t).toBe(true);
      }
    } finally {
      await mcp.close();
    }
  });

  it('serializes and rehydrates without re-listing', async () => {
    const store = new InMemoryMCPCacheStore();
    const mcp = await createMCPTools({
      url,
      ...(auth !== undefined && {
        auth,
      }),
      cache: {
        store,
      },
      cacheCredentials: true,
    });
    const snapshot = await mcp.serialize();
    await mcp.close();

    expect(snapshot.tools.length).toBeGreaterThan(0);

    const rehydrated = await rehydrateMCPTools({
      snapshot,
      ...(auth !== undefined && {
        auth,
      }),
    });
    try {
      expect(rehydrated.tools.length).toBe(snapshot.tools.length);
    } finally {
      await rehydrated.close();
    }
  });
});

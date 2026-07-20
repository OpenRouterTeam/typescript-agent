import { describe, expect, it } from 'vitest';
import { InMemoryMCPCacheStore } from '../../src/cache/cache-store.js';
import { isSerializedMCPServer } from '../../src/cache/cache-types.js';
import { serializeServer } from '../../src/cache/serialize.js';
import type { McpToolDef } from '../../src/tool-wrapper.js';

const toolDefs: McpToolDef[] = [
  {
    name: 'search',
    description: 'search docs',
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
        },
      },
      required: [
        'q',
      ],
    },
    outputSchema: {
      type: 'object',
      properties: {
        hits: {
          type: 'number',
        },
      },
    },
  },
];

describe('serializeServer', () => {
  it('produces a valid snapshot with structural data', async () => {
    const snap = await serializeServer({
      url: 'https://mcp.example.com/mcp',
      transport: 'streamableHttp',
      toolDefs,
      serverInfo: {
        name: 'demo',
        version: '1.0.0',
      },
      cacheCredentials: false,
      cachedAt: 1_000,
    });
    expect(isSerializedMCPServer(snap)).toBe(true);
    expect(snap.tools).toHaveLength(1);
    expect(snap.tools[0]?.outputSchema).toBeDefined();
    expect(snap.cachedAt).toBe(1_000);
  });

  it('replaces a negative cachedAt with a fresh timestamp', async () => {
    const before = Date.now();
    const snap = await serializeServer({
      url: 'https://mcp.example.com/mcp',
      transport: 'streamableHttp',
      toolDefs,
      cacheCredentials: false,
      cachedAt: -1,
    });
    // isFiniteEpoch rejects the negative input, so serializeServer falls back to
    // Date.now() — assert it's the current time, not just any non-negative value,
    // so a regression to a hard-coded sentinel would be caught.
    expect(snap.cachedAt).toBeGreaterThanOrEqual(before);
    expect(snap.cachedAt).toBeLessThanOrEqual(Date.now());
    expect(isSerializedMCPServer(snap)).toBe(true);
  });

  it('omits credentials when cacheCredentials is false', async () => {
    const snap = await serializeServer({
      url: 'https://mcp.example.com/mcp',
      transport: 'streamableHttp',
      toolDefs,
      auth: {
        kind: 'bearer',
        token: 'secret',
      },
      sessionId: 'sess-1',
      cacheCredentials: false,
      cachedAt: 1_000,
    });
    expect(snap.auth).toBeUndefined();
    expect(snap.sessionId).toBeUndefined();
  });

  it('includes credentials + sessionId when cacheCredentials is true', async () => {
    const snap = await serializeServer({
      url: 'https://mcp.example.com/mcp',
      transport: 'streamableHttp',
      toolDefs,
      auth: {
        kind: 'bearer',
        token: 'secret',
      },
      sessionId: 'sess-1',
      cacheCredentials: true,
      cachedAt: 1_000,
    });
    expect(snap.auth?.headers).toEqual({
      Authorization: 'Bearer secret',
    });
    expect(snap.sessionId).toBe('sess-1');
  });
});

describe('InMemoryMCPCacheStore', () => {
  it('round-trips a snapshot through get/set/delete', async () => {
    const store = new InMemoryMCPCacheStore();
    const snap = await serializeServer({
      url: 'https://mcp.example.com/mcp',
      transport: 'sse',
      toolDefs,
      cacheCredentials: false,
      cachedAt: 2_000,
    });
    expect(store.get('k')).toBeNull();
    store.set('k', snap);
    expect(store.get('k')).toEqual(snap);
    store.delete('k');
    expect(store.get('k')).toBeNull();
  });
});

describe('isSerializedMCPServer', () => {
  it('rejects malformed snapshots', () => {
    expect(isSerializedMCPServer(null)).toBe(false);
    expect(
      isSerializedMCPServer({
        version: 2,
      }),
    ).toBe(false);
    expect(
      isSerializedMCPServer({
        version: 1,
        url: 'x',
        transport: 'bogus',
      }),
    ).toBe(false);
    expect(
      isSerializedMCPServer({
        version: 1,
        url: 'https://x',
        transport: 'sse',
        tools: [
          {
            name: 'a',
            inputSchema: {},
          },
        ],
        cachedAt: 1,
      }),
    ).toBe(true);
  });

  it('rejects snapshots with a non-finite or negative cachedAt', () => {
    const base = {
      version: 1,
      url: 'https://x',
      transport: 'sse',
      tools: [
        {
          name: 'a',
          inputSchema: {},
        },
      ],
    };
    for (const cachedAt of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
    ]) {
      expect(
        isSerializedMCPServer({
          ...base,
          cachedAt,
        }),
      ).toBe(false);
    }
  });
});

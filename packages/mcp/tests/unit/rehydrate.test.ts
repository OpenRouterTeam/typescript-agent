import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectOptions, MCPConnection } from '../../src/mcp-connection.js';

// Capture the options every `connect` call receives so we can assert on the auth
// that rehydrate forwards into the transport.
const connectCalls: ConnectOptions[] = [];

vi.mock('../../src/mcp-connection.js', () => ({
  connect: (options: ConnectOptions): Promise<MCPConnection> => {
    connectCalls.push(options);
    const connection: MCPConnection = {
      // Minimal client stand-in: buildTools stores the reference but these tests
      // never invoke a wrapped tool, and capabilities/version are read as absent.
      client: {
        getServerVersion: () => undefined,
        getServerCapabilities: () => undefined,
        // Reached only when rehydrate falls through to a full freshConnect
        // (expired tokens, missing credentials, or a stale snapshot).
        listTools: () =>
          Promise.resolve({
            tools: [],
          }),
      } as never,
      transport: 'streamableHttp',
      setToolListChangedHandler: () => {},
      close: () => Promise.resolve(),
    };
    return Promise.resolve(connection);
  },
}));

const { rehydrateMCPTools } = await import('../../src/rehydrate.js');
const { isSerializedMCPServer } = await import('../../src/cache/cache-types.js');
type SerializedMCPServer = import('../../src/cache/cache-types.js').SerializedMCPServer;

function snapshotWithHeaders(): SerializedMCPServer {
  const snap: SerializedMCPServer = {
    version: 1,
    url: 'https://mcp.example.com/mcp',
    transport: 'streamableHttp',
    tools: [
      {
        name: 'alpha',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'beta',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
    auth: {
      headers: {
        'X-Api-Key': 'secret',
      },
    },
    cachedAt: Date.now(),
  };
  // Guard against drift between the literal above and the validator.
  expect(isSerializedMCPServer(snap)).toBe(true);
  return snap;
}

function nameOf(tool: unknown): string | undefined {
  if (
    typeof tool === 'object' &&
    tool !== null &&
    'function' in tool &&
    typeof tool.function === 'object' &&
    tool.function !== null &&
    'name' in tool.function &&
    typeof tool.function.name === 'string'
  ) {
    return tool.function.name;
  }
  return undefined;
}

describe('rehydrateMCPTools', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('applies toolNamePrefix and excludeTools on a cache hit', async () => {
    const handle = await rehydrateMCPTools({
      snapshot: snapshotWithHeaders(),
      toolNamePrefix: 'svc_',
      excludeTools: [
        'beta',
      ],
    });
    expect(handle.tools.map(nameOf)).toEqual([
      'svc_alpha',
    ]);
  });

  it('reconstructs auth from a credential-bearing snapshot when no auth is passed', async () => {
    await rehydrateMCPTools({
      snapshot: snapshotWithHeaders(),
    });
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0]?.auth).toEqual({
      kind: 'headers',
      headers: {
        'X-Api-Key': 'secret',
      },
    });
  });

  it('reconstructs a bearer token from snapshot tokens', async () => {
    const snap = snapshotWithHeaders();
    snap.auth = {
      tokens: {
        accessToken: 'token-123',
      },
    };
    await rehydrateMCPTools({
      snapshot: snap,
    });
    expect(connectCalls[0]?.auth).toEqual({
      kind: 'bearer',
      token: 'token-123',
    });
  });
});

describe('staleness on the direct rehydrate path', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('replays a snapshot that is within maxAgeMs', async () => {
    const snapshot = snapshotWithHeaders();
    snapshot.cachedAt = Date.now() - 1_000;

    const handle = await rehydrateMCPTools({
      snapshot,
      staleness: {
        maxAgeMs: 60_000,
      },
    });

    // Replayed from the snapshot: both cached tools, no re-list.
    expect(handle.tools.map(nameOf)).toEqual([
      'alpha',
      'beta',
    ]);
    await handle.close();
  });

  it('re-lists instead of replaying when the snapshot is older than maxAgeMs', async () => {
    const snapshot = snapshotWithHeaders();
    snapshot.cachedAt = Date.now() - 120_000;

    const handle = await rehydrateMCPTools({
      snapshot,
      staleness: {
        maxAgeMs: 60_000,
      },
    });

    // The fake client reports no tools, so a fresh listTools() yields an empty
    // set — proving we went through freshConnect rather than the snapshot.
    expect(handle.tools).toHaveLength(0);
    await handle.close();
  });

  it('replays regardless of age when no maxAgeMs is given', async () => {
    const snapshot = snapshotWithHeaders();
    snapshot.cachedAt = Date.now() - 10 * 24 * 60 * 60 * 1000;

    const handle = await rehydrateMCPTools({
      snapshot,
    });

    expect(handle.tools.map(nameOf)).toEqual([
      'alpha',
      'beta',
    ]);
    await handle.close();
  });
});

/**
 * Regression: a replay must not reset the staleness clock.
 *
 * `makeHandle` writes the snapshot back to the cache on construction, and
 * `serializeArgs` stamped `cachedAt: Date.now()` unconditionally. On the replay
 * path that restamped a tool set that was never re-listed, so every rehydrate
 * pushed the age back to zero and `staleness.maxAgeMs` could never fire on a
 * repeatedly-rehydrated snapshot — silently serving unbounded-age tools.
 */
describe('replay preserves snapshot age', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('does not restamp cachedAt when tool defs come from a snapshot', async () => {
    const { InMemoryMCPCacheStore } = await import('../../src/cache/cache-store.js');
    const store = new InMemoryMCPCacheStore();
    const snap = snapshotWithHeaders();
    const originalCachedAt = snap.cachedAt - 60_000; // an hour-old-ish snapshot
    store.set('warm', {
      ...snap,
      cachedAt: originalCachedAt,
    });

    await rehydrateMCPTools({
      snapshot: {
        ...snap,
        cachedAt: originalCachedAt,
      },
      cache: {
        store,
        key: 'warm',
      },
    });

    const written = await store.get('warm');
    expect(written?.cachedAt).toBe(originalCachedAt);
  });

  /**
   * The mirror of the case above. `refresh()` clears `replayedCachedAt`, so a
   * genuine re-list stamps the write with the current time. Without that clear
   * a replayed handle would keep writing the original snapshot timestamp
   * forever, and every later rehydrate would read a permanently-stale age and
   * take the `freshConnect` path — the cache would never warm again.
   */
  it('restamps cachedAt once a replayed handle genuinely re-lists', async () => {
    const { InMemoryMCPCacheStore } = await import('../../src/cache/cache-store.js');
    const store = new InMemoryMCPCacheStore();
    const snap = snapshotWithHeaders();
    const originalCachedAt = snap.cachedAt - 60_000;
    const replayed = {
      ...snap,
      cachedAt: originalCachedAt,
    };
    store.set('warm', replayed);

    const handle = await rehydrateMCPTools({
      snapshot: replayed,
      cache: {
        store,
        key: 'warm',
      },
    });

    // Precondition: the replay wrote the original age through (case above).
    expect((await store.get('warm'))?.cachedAt).toBe(originalCachedAt);

    const before = Date.now();
    await handle.refresh();
    const written = await store.get('warm');

    expect(written?.cachedAt).not.toBe(originalCachedAt);
    expect(written?.cachedAt).toBeGreaterThanOrEqual(before);
    expect(written?.cachedAt).toBeLessThanOrEqual(Date.now());
  });
});

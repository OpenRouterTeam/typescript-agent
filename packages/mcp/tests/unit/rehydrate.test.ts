import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPCacheError } from '../../src/errors.js';
import type { ConnectOptions, MCPConnection } from '../../src/mcp-connection.js';

// Capture the options every `connect` call receives so we can assert on the auth
// that rehydrate forwards into the transport.
const connectCalls: ConnectOptions[] = [];

// How many of those connections were closed. Guards the replay path's teardown:
// a failure after `connect()` must not leave the transport open.
let closeCount = 0;

// When true, the fake client's `listTools` rejects — used to drive the
// stale-snapshot re-list into failure.
let listToolsRejects = false;

// When true, the connection's `close()` throws synchronously rather than
// returning a rejected promise — the case a bare `.catch()` cannot intercept.
let closeThrowsSync = false;

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
          listToolsRejects
            ? Promise.reject(new Error('server unavailable'))
            : Promise.resolve({
                tools: [],
              }),
      } as never,
      transport: 'streamableHttp',
      setToolListChangedHandler: () => {},
      close: () => {
        closeCount += 1;
        if (closeThrowsSync) {
          throw new Error('close exploded');
        }
        return Promise.resolve();
      },
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
    closeCount = 0;
    listToolsRejects = false;
    closeThrowsSync = false;
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
    closeCount = 0;
    listToolsRejects = false;
    closeThrowsSync = false;
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

  /**
   * `reconnectOnExpiry: false` opts out of rebuilding the transport, not out of
   * bounded-age tools. A stale snapshot skips `freshConnect` on that setting, so
   * without an explicit re-list it would replay unbounded-age tools with neither
   * a refresh nor an error — the hole `staleness.maxAgeMs` exists to close.
   */
  it('re-lists a stale snapshot even when reconnectOnExpiry is false', async () => {
    const snapshot = snapshotWithHeaders();
    snapshot.cachedAt = Date.now() - 120_000;

    const handle = await rehydrateMCPTools({
      snapshot,
      staleness: {
        maxAgeMs: 60_000,
      },
      reconnectOnExpiry: false,
    });

    // Re-listed over the replayed connection: the fake reports no tools, so an
    // empty set proves the snapshot's `alpha`/`beta` were not served.
    expect(handle.tools).toHaveLength(0);
    // And it did so without the reconnect the caller opted out of — one connect
    // for the replay, no second one from `freshConnect`.
    expect(connectCalls).toHaveLength(1);
    await handle.close();
  });

  /**
   * The replay path opens a connection, so a failure after that point has to
   * tear it down — otherwise the transport (HTTP keep-alive / SSE stream) leaks
   * for the process lifetime, and a service that retries exhausts its sockets.
   * `freshConnect` already guarantees this on the cold path; this is the replay
   * path's mirror. A caller's `cache.store.set` throwing during the initial
   * write-back is the cheapest way in.
   */
  it('closes the replay connection when the initial cache write fails', async () => {
    const failingStore = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error('disk full')),
      delete: () => Promise.resolve(),
    };

    await expect(
      rehydrateMCPTools({
        snapshot: snapshotWithHeaders(),
        cache: {
          store: failingStore,
          key: 'warm',
        },
        // Without this the failure falls back to freshConnect, which opens its
        // own connection and muddies the count.
        reconnectOnExpiry: false,
      }),
    ).rejects.toThrow(MCPCacheError);

    // One connection opened for the replay, and it was closed rather than leaked.
    expect(connectCalls).toHaveLength(1);
    expect(closeCount).toBe(1);
  });

  /**
   * Devin flagged that the re-list above turns a previously-survivable replay
   * into a hard failure. That is deliberate — serving tools the caller declared
   * too old is the bug `maxAgeMs` exists to prevent — but the error has to say
   * *why*, and the connection still has to be released.
   */
  it('fails with a staleness-specific error when the re-list rejects', async () => {
    const snapshot = snapshotWithHeaders();
    snapshot.cachedAt = Date.now() - 120_000;
    listToolsRejects = true;

    await expect(
      rehydrateMCPTools({
        snapshot,
        staleness: {
          maxAgeMs: 60_000,
        },
        reconnectOnExpiry: false,
      }),
    ).rejects.toThrow(/older than staleness\.maxAgeMs/);

    // Released rather than leaked, same guarantee as the other failure paths.
    expect(closeCount).toBe(1);
  });

  /**
   * A synchronous throw from `close()` never produces a rejected promise, so a
   * bare `.catch()` on the call would let it escape from inside the `catch (err)`
   * block — replacing the real failure and, worse, skipping the `freshConnect`
   * fallback below it. A rehydrate that used to self-heal would start rejecting
   * because its *teardown* misbehaved. `closeQuietly` wraps the call in a `try`
   * so neither happens.
   */
  it('still falls back to freshConnect when the teardown close() throws synchronously', async () => {
    // Fails the replay's write only, so the fallback can still succeed — the
    // point is that the teardown throw doesn't prevent reaching it.
    let writes = 0;
    const flakyStore = {
      get: () => Promise.resolve(undefined),
      set: () => {
        writes += 1;
        return writes === 1 ? Promise.reject(new Error('disk full')) : Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };
    closeThrowsSync = true;

    // reconnectOnExpiry defaults to true, so the write failure should self-heal
    // through freshConnect rather than surfacing the teardown error.
    const handle = await rehydrateMCPTools({
      snapshot: snapshotWithHeaders(),
      cache: {
        store: flakyStore,
        key: 'warm',
      },
    });

    // Two connects: the failed replay, then the fallback that self-healed.
    expect(connectCalls).toHaveLength(2);
    expect(handle.tools).toHaveLength(0);
  });

  it('reports the original failure, not the teardown failure, when close() throws', async () => {
    const failingStore = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error('disk full')),
      delete: () => Promise.resolve(),
    };
    closeThrowsSync = true;

    await expect(
      rehydrateMCPTools({
        snapshot: snapshotWithHeaders(),
        cache: {
          store: failingStore,
          key: 'warm',
        },
        reconnectOnExpiry: false,
      }),
      // 'close exploded' would mean the teardown error had masked the real one.
    ).rejects.toThrow(MCPCacheError);
  });

  it('still replays a fresh snapshot when reconnectOnExpiry is false', async () => {
    const snapshot = snapshotWithHeaders();
    snapshot.cachedAt = Date.now() - 1_000;

    const handle = await rehydrateMCPTools({
      snapshot,
      staleness: {
        maxAgeMs: 60_000,
      },
      reconnectOnExpiry: false,
    });

    expect(handle.tools.map(nameOf)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(connectCalls).toHaveLength(1);
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
    closeCount = 0;
    listToolsRejects = false;
    closeThrowsSync = false;
  });

  it('does not restamp cachedAt when tool defs come from a snapshot', async () => {
    const { InMemoryMCPCacheStore } = await import('../../src/cache/cache-store.js');
    const store = new InMemoryMCPCacheStore();
    const snap = snapshotWithHeaders();
    const originalCachedAt = snap.cachedAt - 60_000; // a minute-old snapshot
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

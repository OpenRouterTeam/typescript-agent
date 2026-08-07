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

// When true, `connect` itself rejects with an auth-marked error, exercising the
// fallback guard: rejected credentials must not trigger a third reconnect.
let connectRejectsAuth = false;

// When set, `connect` rejects with exactly this error (non-auth).
let connectRejects: Error | undefined;

// When true, the connection's `close()` throws synchronously rather than
// returning a rejected promise — the case a bare `.catch()` cannot intercept.
let closeThrowsSync = false;

vi.mock('../../src/mcp-connection.js', () => ({
  // Minimal stand-in for the real guard: these tests drive auth failures with a
  // `FakeUnauthorized` whose marker the walk below recognises.
  isAuthFailure: (err: unknown): boolean =>
    typeof err === 'object' && err !== null && 'isFakeAuthFailure' in err,
  connect: (options: ConnectOptions): Promise<MCPConnection> => {
    connectCalls.push(options);
    if (connectRejectsAuth) {
      return Promise.reject(
        Object.assign(new Error('unauthorized'), {
          isFakeAuthFailure: true,
        }),
      );
    }
    if (connectRejects !== undefined) {
      return Promise.reject(connectRejects);
    }
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

/**
 * A snapshot whose two tools share a name. `buildTools` rejects duplicates, so
 * this is a genuine post-connect failure — unlike a failing cache write, which is
 * now best-effort and no longer aborts handle construction.
 */
function snapshotWithDuplicateToolNames(): SerializedMCPServer {
  const snap = snapshotWithHeaders();
  return {
    ...snap,
    tools: snap.tools.map((t) => ({
      ...t,
      name: 'collide',
    })),
  };
}

function loopKeyOf(tool: unknown): unknown {
  if (
    typeof tool === 'object' &&
    tool !== null &&
    'function' in tool &&
    typeof tool.function === 'object' &&
    tool.function !== null &&
    'loopKey' in tool.function
  ) {
    return tool.function.loopKey;
  }
  return undefined;
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
    connectRejectsAuth = false;
    connectRejects = undefined;
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

  /**
   * A snapshot's `sessionId` must not be forwarded into `connect()`.
   *
   * When a transport reports a sessionId, SDK v2 skips negotiation entirely — no
   * probe, no `initialize` — and returns with `getProtocolEra()`,
   * `getServerCapabilities()` and `getServerVersion()` all undefined. It does not
   * throw, which is what makes it dangerous: `serverHasResources()` reads those
   * capabilities, so the replay would silently come back without resource tools.
   * Protocol sessions are also gone in 2026-07-28 (SEP-2567).
   */
  it('does not replay a snapshot sessionId onto the new connection', async () => {
    const snap = snapshotWithHeaders();
    snap.sessionId = 'resumed-session-123';

    await rehydrateMCPTools({
      snapshot: snap,
    });

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0]?.sessionId).toBeUndefined();
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
    connectRejectsAuth = false;
    connectRejects = undefined;
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
  it('closes the replay connection when building the tool set fails', async () => {
    await expect(
      rehydrateMCPTools({
        snapshot: snapshotWithDuplicateToolNames(),
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
    closeThrowsSync = true;

    // reconnectOnExpiry defaults to true, so the build failure should self-heal
    // through freshConnect (which re-lists and gets the fake's empty tool set)
    // rather than surfacing the teardown error.
    const handle = await rehydrateMCPTools({
      snapshot: snapshotWithDuplicateToolNames(),
    });

    // Two connects: the failed replay, then the fallback that self-healed.
    expect(connectCalls).toHaveLength(2);
    expect(handle.tools).toHaveLength(0);
  });

  it('reports the original failure, not the teardown failure, when close() throws', async () => {
    closeThrowsSync = true;

    await expect(
      rehydrateMCPTools({
        snapshot: snapshotWithDuplicateToolNames(),
        reconnectOnExpiry: false,
      }),
      // 'close exploded' would mean the teardown error had masked the real one.
    ).rejects.toThrow(MCPCacheError);
  });

  /**
   * A cache-store outage must not fail a rehydrate whose tools were just read.
   *
   * `refresh()` re-lists and *then* writes back, so both steps used to surface
   * identically — and the stale path converted either into
   * `MCPStaleSnapshotError`, discarding a live connection with current tools and
   * blaming the re-list. Worse, the documented recovery (`rehydrateMCPTools`
   * without `staleness`) writes through the same broken store, so it failed too:
   * the escape hatch was as broken as the thing it escaped.
   */
  it('survives a cache-store write failure on the stale path', async () => {
    const snapshot = snapshotWithHeaders();
    snapshot.cachedAt = Date.now() - 120_000;
    const writeOnlyFailure = {
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error('store unavailable')),
      delete: () => Promise.resolve(),
    };

    const handle = await rehydrateMCPTools({
      snapshot,
      cache: {
        store: writeOnlyFailure,
        key: 'warm',
      },
      staleness: {
        maxAgeMs: 60_000,
      },
      reconnectOnExpiry: false,
    });

    // Re-listed successfully (the fake reports no tools), so the handle is usable
    // even though the snapshot could not be persisted.
    expect(handle.tools).toHaveLength(0);
    expect(closeCount).toBe(0);
  });

  /**
   * The stale path keys survival on ADOPTION, not on error class.
   *
   * `refresh()` can fail after adopting the re-listed tools for a reason that
   * is not a tagged store write — the caller's own OAuth `provider.tokens()`
   * rejecting inside `snapshot()` propagates untagged (deliberately: it is a
   * credential failure, not a store outage). The re-list succeeded, so the
   * tools are current; closing the connection and blaming the re-list would be
   * wrong on both counts.
   */
  it('survives an untagged post-re-list failure on the stale path', async () => {
    const snapshot = snapshotWithHeaders();
    snapshot.cachedAt = Date.now() - 120_000;
    const store = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };

    const handle = await rehydrateMCPTools({
      snapshot,
      cacheCredentials: true,
      cache: {
        store,
        key: 'warm',
      },
      staleness: {
        maxAgeMs: 60_000,
      },
      reconnectOnExpiry: false,
      auth: {
        kind: 'oauth',
        provider: {
          // Fails during the stale refresh's snapshot build — after the
          // re-list already adopted the fresh (empty) tool set.
          tokens: () => Promise.reject(new Error('provider outage')),
        } as never,
      },
    });

    // The re-list adopted the fresh set; only persisting it failed.
    expect(handle.tools).toHaveLength(0);
    expect(closeCount).toBe(0);
  });

  /**
   * A credential rejection must not trigger the freshConnect fallback.
   *
   * The fallback is a third reconnect layer reusing the same auth. connect()'s
   * internal ladder and its legacy retry both already refuse to continue past an
   * auth failure, because re-entering the SDK's auth path drives a second
   * `redirectToAuthorization` and overwrites the saved PKCE verifier — so letting
   * the rehydrate fallback do the same one layer up would defeat both guards.
   */
  /**
   * An aborted caller gets no freshConnect fallback — the third reconnect
   * layer, matching the SSE-fallback and legacy-retry guards. A cancelled
   * setup must not dial the server again, and the caller should see their
   * cancellation, not a fabricated connect failure.
   */
  it('does not fall back to freshConnect when the caller aborted', async () => {
    const controller = new AbortController();
    connectRejectsAuth = false;
    // The replay's connect fails because the abort landed during it.
    connectRejects = new Error('aborted mid-connect');
    controller.abort();

    await expect(
      rehydrateMCPTools({
        snapshot: snapshotWithHeaders(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(MCPCacheError);

    // One connect only — the replay attempt. No fresh dial behind an abort.
    expect(connectCalls).toHaveLength(1);
  });

  it('does not fall back to freshConnect on an auth failure', async () => {
    connectRejectsAuth = true;

    await expect(
      rehydrateMCPTools({
        snapshot: snapshotWithHeaders(),
      }),
    ).rejects.toThrow(MCPCacheError);

    // One connect only: the replay attempt. No freshConnect behind it.
    expect(connectCalls).toHaveLength(1);
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
    connectRejectsAuth = false;
    connectRejects = undefined;
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
   * A replay does not write at all. With `replayedCachedAt` carried forward the
   * snapshot it would write is byte-equivalent to the one just read, so the
   * write was one external store round-trip per rehydrate buying nothing —
   * and one more path that could rewrite a credentialed entry under different
   * options (DEV-766). `refresh()` still writes: it re-lists, so it has
   * something new to persist.
   */
  /**
   * Two exceptions to the replay-skips-write rule, both maintenance rather
   * than restamping:
   *
   * 1. A legacy `sessionId` in the stored entry is scrubbed — one write of the
   *    same snapshot minus the field, so the bearer-equivalent value stops
   *    sitting in the external store indefinitely on the warm path.
   * 2. The scrub copies rather than re-serializes, so it cannot strip
   *    credentials the way a re-serialize under this call's options would
   *    (DEV-766).
   */
  it('scrubs a legacy sessionId from the stored entry on replay', async () => {
    const snap = {
      ...snapshotWithHeaders(),
      sessionId: 'legacy-bearer-equivalent',
    };
    const writes: unknown[] = [];
    const store = {
      // The credential-bearing legacy entry lives in THIS store — the scrub
      // reads back before writing, so it only ever rewrites bytes the store
      // already holds.
      get: () => Promise.resolve(snap),
      set: (_key: string, value: unknown) => {
        writes.push(value);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await rehydrateMCPTools({
      snapshot: snap,
      cache: {
        store,
        key: 'warm',
      },
    });

    expect(writes).toHaveLength(1);
    const written = writes[0] as Record<string, unknown>;
    expect(Object.hasOwn(written, 'sessionId')).toBe(false);
    // The scrub preserved everything else — including the credential block a
    // re-serialize under unset cacheCredentials would have dropped.
    expect(written['auth']).toEqual(snap.auth);
    expect(written['cachedAt']).toBe(snap.cachedAt);
  });

  /**
   * The scrub must not introduce credentials into a store that never held them.
   *
   * A direct rehydrate may load its snapshot from a file or a different store;
   * writing that snapshot's auth block into this store — even sessionId-scrubbed
   * — would persist credentials without the `cacheCredentials` opt-in. The
   * read-back gate means an empty (or sessionId-free) store entry produces no
   * write at all.
   */
  /**
   * A stale refresh must not be clobbered by the maintenance scrub.
   *
   * On the over-age + `reconnectOnExpiry: false` path, `refresh()` re-lists and
   * writes the fresh entry (serialize omits `sessionId`, carries current
   * tokens). Running the scrub after that would overwrite the just-refreshed
   * entry with the caller's older input snapshot — the store would go straight
   * back to being out of date, and every subsequent load would pay the re-list
   * again.
   */
  it('does not clobber a stale-refresh write with the older snapshot', async () => {
    const snap = {
      ...snapshotWithHeaders(),
      sessionId: 'legacy-bearer-equivalent',
    };
    snap.cachedAt = Date.now() - 120_000;
    const writes: Record<string, unknown>[] = [];
    const store = {
      get: () => Promise.resolve(snap),
      set: (_key: string, value: unknown) => {
        writes.push(value as Record<string, unknown>);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await rehydrateMCPTools({
      snapshot: snap,
      staleness: {
        maxAgeMs: 60_000,
      },
      reconnectOnExpiry: false,
      cache: {
        store,
        key: 'warm',
      },
    });

    // Exactly one write: the refresh's. No scrub write behind it re-persisting
    // the stale tool set or the old cachedAt.
    expect(writes).toHaveLength(1);
    const written = writes[0] as Record<string, unknown>;
    expect(Object.hasOwn(written, 'sessionId')).toBe(false);
    expect(written['cachedAt']).not.toBe(snap.cachedAt);
  });

  it('does not write when the store itself holds no legacy sessionId', async () => {
    const writes: unknown[] = [];
    const store = {
      get: () => Promise.resolve(null),
      set: (_key: string, value: unknown) => {
        writes.push(value);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };
    const snap = {
      ...snapshotWithHeaders(),
      // The caller's input snapshot carries one — but the store does not.
      sessionId: 'from-somewhere-else',
    };

    await rehydrateMCPTools({
      snapshot: snap,
      cache: {
        store,
        key: 'warm',
      },
    });

    expect(writes).toHaveLength(0);
  });

  /**
   * An UNROTATED token grafts nothing: no write at all.
   *
   * Three hazards die together. The per-replay write (warm-path economy, and
   * TTL-extending stores like Redis SETEX would be re-touched on every hit);
   * the expiry ratchet (`serializeServer` stamps `expiresAt` from `Date.now()
   * + expires_in * 1000`, but `expires_in` is relative to issuance, so
   * re-persisting the same token pushes the recorded expiry forward every
   * replay and `tokensExpired()` never trips); and field loss (a wholesale
   * replace would drop stored fields the provider's `tokens()` no longer
   * reports — a refreshToken held elsewhere — with no actual rotation).
   */
  it('does not write at all when the OAuth token is unrotated', async () => {
    const snap = snapshotWithHeaders();
    // Unexpired (well past the 30s skew) so the replay path runs.
    snap.auth = {
      tokens: {
        accessToken: 'same-token',
        refreshToken: 'held-outside-the-provider',
        expiresAt: Date.now() + 120_000,
      },
    };
    const writes: unknown[] = [];
    const store = {
      // Warm path: the store holds the entry being replayed.
      get: () => Promise.resolve(snap),
      set: (_key: string, value: unknown) => {
        writes.push(value);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await rehydrateMCPTools({
      snapshot: snap,
      cacheCredentials: true,
      cache: {
        store,
        key: 'warm',
      },
      auth: {
        kind: 'oauth',
        provider: {
          // Same token as the snapshot, with a fresh-looking hour of lifetime —
          // a raw re-persist would ratchet expiry to ~now + 1h and drop the
          // stored refreshToken.
          tokens: () =>
            Promise.resolve({
              access_token: 'same-token',
              token_type: 'bearer',
              expires_in: 3600,
            }),
        } as never,
      },
    });

    expect(writes).toHaveLength(0);
  });

  /**
   * A ROTATED token's recomputed expiry stands: the SDK just obtained it, so its
   * relative `expires_in` genuinely is measured from about now.
   */
  it('restamps expiresAt when the provider rotated to a new OAuth token', async () => {
    const snap = snapshotWithHeaders();
    const originalExpiresAt = Date.now() + 120_000;
    snap.auth = {
      tokens: {
        accessToken: 'old-token',
        expiresAt: originalExpiresAt,
      },
    };
    const writes: Record<string, unknown>[] = [];
    const store = {
      get: () => Promise.resolve(snap),
      set: (_key: string, value: unknown) => {
        writes.push(value as Record<string, unknown>);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    const before = Date.now();
    await rehydrateMCPTools({
      snapshot: snap,
      cacheCredentials: true,
      cache: {
        store,
        key: 'warm',
      },
      auth: {
        kind: 'oauth',
        provider: {
          tokens: () =>
            Promise.resolve({
              access_token: 'rotated-token',
              token_type: 'bearer',
              expires_in: 3600,
            }),
        } as never,
      },
    });

    expect(writes).toHaveLength(1);
    const tokens = (
      writes[0]?.['auth'] as {
        tokens?: Record<string, unknown>;
      }
    ).tokens;
    expect(tokens?.['accessToken']).toBe('rotated-token');
    // Restamped from the fresh grant, not carried from the old token.
    expect(tokens?.['expiresAt']).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  /**
   * The rotation write must not roll a newer store entry back to the caller's
   * older input snapshot.
   *
   * A direct `rehydrateMCPTools` may load its snapshot from a file while a
   * concurrent `refresh()` has since written a newer entry (more tools, newer
   * `cachedAt`) to the same key. The maintenance write reads the store back and
   * grafts ONLY the token block onto the stored entry — tool set and `cachedAt`
   * stay the store's.
   */
  it('does not roll back a newer store entry when rotating tokens on a direct rehydrate', async () => {
    const older = snapshotWithHeaders();
    older.cachedAt = Date.now() - 60_000;
    older.auth = {
      tokens: {
        accessToken: 'old-token',
        expiresAt: Date.now() + 120_000,
      },
    };
    // The store's entry is newer: an extra tool, a fresher cachedAt.
    const newer: SerializedMCPServer = {
      ...older,
      cachedAt: Date.now() - 1_000,
      tools: [
        ...older.tools,
        {
          name: 'gamma',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
    const writes: Record<string, unknown>[] = [];
    const store = {
      get: () => Promise.resolve(newer),
      set: (_key: string, value: unknown) => {
        writes.push(value as Record<string, unknown>);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await rehydrateMCPTools({
      snapshot: older,
      cacheCredentials: true,
      cache: {
        store,
        key: 'warm',
      },
      auth: {
        kind: 'oauth',
        provider: {
          tokens: () =>
            Promise.resolve({
              access_token: 'rotated-token',
              token_type: 'bearer',
              expires_in: 3600,
            }),
        } as never,
      },
    });

    expect(writes).toHaveLength(1);
    const written = writes[0] as unknown as SerializedMCPServer;
    // The store's newer tool set and cachedAt survive; only tokens moved.
    expect(written.tools.map((t) => t.name)).toEqual(newer.tools.map((t) => t.name));
    expect(written.cachedAt).toBe(newer.cachedAt);
    expect(written.auth?.tokens?.accessToken).toBe('rotated-token');
  });

  /**
   * The rotation write cannot introduce credentials into a store whose entry
   * never held tokens — and an empty store gets no write at all. Same
   * no-introduce guarantee the scrub has always had, now shared via the
   * read-back.
   */
  it('does not introduce tokens into a store entry that never held them', async () => {
    const snap = snapshotWithHeaders();
    snap.auth = {
      tokens: {
        accessToken: 'from-a-file',
        expiresAt: Date.now() + 120_000,
      },
    };
    // The store's own entry is credential-free (headers only, no tokens).
    const storedWithoutTokens = snapshotWithHeaders();
    const writes: unknown[] = [];
    const store = {
      get: () => Promise.resolve(storedWithoutTokens),
      set: (_key: string, value: unknown) => {
        writes.push(value);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await rehydrateMCPTools({
      snapshot: snap,
      cacheCredentials: true,
      cache: {
        store,
        key: 'warm',
      },
      auth: {
        kind: 'oauth',
        provider: {
          tokens: () =>
            Promise.resolve({
              access_token: 'fresh-token',
              token_type: 'bearer',
              expires_in: 3600,
            }),
        } as never,
      },
    });

    expect(writes).toHaveLength(0);
  });

  /**
   * Static credentials rotate too. The old per-hit write kept stored
   * `auth.headers` in sync with the caller's live `auth`; skipping the replay
   * write-back would leave a rotated bearer/API key stale in the store, and
   * `authFromSnapshot` would later reconnect with the superseded secret. Same
   * graft rules as OAuth: read back, move only the header block, tools and
   * cachedAt stay the store's.
   */
  it('updates stored headers when a static credential rotated', async () => {
    const snap = snapshotWithHeaders(); // stored auth: X-Api-Key: secret
    const writes: Record<string, unknown>[] = [];
    const store = {
      get: () => Promise.resolve(snap),
      set: (_key: string, value: unknown) => {
        writes.push(value as Record<string, unknown>);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await rehydrateMCPTools({
      snapshot: snap,
      cacheCredentials: true,
      cache: {
        store,
        key: 'warm',
      },
      auth: {
        kind: 'headers',
        headers: {
          'X-Api-Key': 'rotated-secret',
        },
      },
    });

    expect(writes).toHaveLength(1);
    const written = writes[0] as unknown as SerializedMCPServer;
    expect(written.auth?.headers).toEqual({
      'X-Api-Key': 'rotated-secret',
    });
    expect(written.cachedAt).toBe(snap.cachedAt);
    expect(written.tools.map((t) => t.name)).toEqual(snap.tools.map((t) => t.name));
  });

  /**
   * Unchanged static credentials produce no write — the graft is for rotation,
   * not a per-replay rewrite. (The read-back itself is the price of having
   * cacheCredentials + caller auth on a replay.)
   */
  it('does not write when the static credential is unchanged', async () => {
    const snap = snapshotWithHeaders();
    const writes: unknown[] = [];
    const store = {
      get: () => Promise.resolve(snap),
      set: (_key: string, value: unknown) => {
        writes.push(value);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await rehydrateMCPTools({
      snapshot: snap,
      cacheCredentials: true,
      cache: {
        store,
        key: 'warm',
      },
      auth: {
        kind: 'headers',
        headers: {
          'X-Api-Key': 'secret',
        },
      },
    });

    expect(writes).toHaveLength(0);
  });

  /**
   * The static graft never introduces headers into a stored entry that has
   * none — same no-introduce rule as the token graft.
   */
  it('does not introduce headers into a store entry that never held them', async () => {
    const storedWithoutCreds: SerializedMCPServer = {
      ...snapshotWithHeaders(),
    };
    storedWithoutCreds.auth = undefined;
    const writes: unknown[] = [];
    const store = {
      get: () => Promise.resolve(storedWithoutCreds),
      set: (_key: string, value: unknown) => {
        writes.push(value);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await rehydrateMCPTools({
      snapshot: snapshotWithHeaders(),
      cacheCredentials: true,
      cache: {
        store,
        key: 'warm',
      },
      auth: {
        kind: 'headers',
        headers: {
          'X-Api-Key': 'rotated-secret',
        },
      },
    });

    expect(writes).toHaveLength(0);
  });

  /**
   * A warm hit with a modern (sessionId-free) snapshot performs ZERO store
   * operations — no write (the no-op skip) and no read (the scrub gate keys on
   * the input snapshot, which on the warm path IS the store's entry). Only
   * legacy entries pay the read-back.
   */
  it('touches the store zero times on a modern warm replay', async () => {
    let gets = 0;
    let sets = 0;
    const store = {
      get: () => {
        gets += 1;
        return Promise.resolve(null);
      },
      set: () => {
        sets += 1;
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await rehydrateMCPTools({
      snapshot: snapshotWithHeaders(),
      cache: {
        store,
        key: 'warm',
      },
    });

    expect(gets).toBe(0);
    expect(sets).toBe(0);
  });

  it('skips the write-back entirely on a replay, but writes after refresh', async () => {
    const sets: string[] = [];
    const countingStore = {
      get: () => Promise.resolve(null),
      set: (key: string) => {
        sets.push(key);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    const handle = await rehydrateMCPTools({
      snapshot: snapshotWithHeaders(),
      cache: {
        store: countingStore,
        key: 'warm',
      },
    });
    expect(sets).toHaveLength(0);

    await handle.refresh();
    expect(sets).toEqual([
      'warm',
    ]);
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

/**
 * Regression: options `createMCPTools` forwards into `rehydrateMCPTools`.
 *
 * The forwarding is an explicit allowlist (`FORWARDED_REHYDRATE_KEYS`).
 * `loopKeys` was missing from it, so with caching enabled the cache-hit path
 * silently dropped the caller's doom-loop identities — detection went dead on
 * warm handles only, with no error and no failing test. Asserting on the
 * resulting tool def rather than the internal list keeps this honest regardless
 * of how forwarding is implemented.
 */
describe('createMCPTools cache-hit option forwarding', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('forwards client-configured loopKeys into the rehydrated handle', async () => {
    const { createMCPTools } = await import('../../src/create-mcp-tools.js');
    const { InMemoryMCPCacheStore } = await import('../../src/cache/cache-store.js');

    const store = new InMemoryMCPCacheStore();
    store.set('warm', snapshotWithHeaders());

    const handle = await createMCPTools({
      url: 'https://mcp.example.com/mcp',
      cache: {
        store,
        key: 'warm',
      },
      loopKeys: {
        alpha: [
          'command',
        ],
      },
    });

    // Served from cache, not a fresh list.
    expect(connectCalls).toHaveLength(1);
    const alpha = handle.tools.find((t) => nameOf(t) === 'alpha');
    expect(loopKeyOf(alpha)).toEqual([
      'command',
    ]);
  });
});

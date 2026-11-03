import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedMCPServer } from '../../../src/mcp/cache/cache-types.js';
import type { ConnectOptions, MCPConnection } from '../../../src/mcp/mcp-connection.js';

// A controllable fake connection: tests set how `listTools` behaves and inspect
// whether `close()` was called and capture the registered list_changed handler.
interface FakeState {
  listTools: () => Promise<{
    tools: {
      name: string;
      inputSchema: Record<string, unknown>;
    }[];
    nextCursor?: string;
  }>;
  closed: number;
  listChangedHandler: (() => void) | undefined;
  connectedUrls: string[];
  connectedAuth: ConnectOptions['auth'][];
}

const state: FakeState = {
  listTools: () =>
    Promise.resolve({
      tools: [],
    }),
  closed: 0,
  listChangedHandler: undefined,
  connectedUrls: [],
  connectedAuth: [],
};

vi.mock('../../../src/mcp/mcp-connection.js', () => ({
  connect: (options: ConnectOptions): Promise<MCPConnection> => {
    state.connectedUrls.push(options.url.href);
    state.connectedAuth.push(options.auth);
    const connection: MCPConnection = {
      client: {
        getServerVersion: () => undefined,
        getServerCapabilities: () => undefined,
        listTools: () => state.listTools(),
      } as never,
      transport: 'streamableHttp',
      setToolListChangedHandler: (handler: () => void) => {
        state.listChangedHandler = handler;
      },
      close: () => {
        state.closed += 1;
        return Promise.resolve();
      },
    };
    return Promise.resolve(connection);
  },
}));

const { createMCPTools } = await import('../../../src/mcp/create-mcp-tools.js');

describe('createMCPTools setup teardown', () => {
  beforeEach(() => {
    state.closed = 0;
    state.listChangedHandler = undefined;
    state.connectedUrls = [];
    state.connectedAuth = [];
    state.listTools = () =>
      Promise.resolve({
        tools: [],
      });
  });

  it('closes the connection when tool discovery fails', async () => {
    state.listTools = () => Promise.reject(new Error('listTools failed'));
    await expect(
      createMCPTools({
        url: 'https://mcp.example.com/mcp',
      }),
    ).rejects.toThrow('listTools failed');
    expect(state.closed).toBe(1);
  });

  it('does not let a failed list_changed refresh escape as an unhandled rejection', async () => {
    let calls = 0;
    state.listTools = () => {
      calls += 1;
      // Succeed on initial discovery, reject on the refresh triggered below.
      if (calls === 1) {
        return Promise.resolve({
          tools: [],
        });
      }
      return Promise.reject(new Error('refresh failed'));
    };

    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onRejection);
    try {
      await createMCPTools({
        url: 'https://mcp.example.com/mcp',
      });
      expect(state.listChangedHandler).toBeDefined();
      state.listChangedHandler?.();
      // Let the rejected refresh microtask settle and any unhandled-rejection
      // detection fire.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  /**
   * A failed cache WRITE must not silence the list_changed announcement.
   *
   * `refresh()` adopts the new tools before it writes the snapshot back, so by
   * the time a store outage surfaces as `MCPCacheWriteError`, `handle.tools`
   * already returns the new set. Skipping notification there left subscribers
   * permanently out of sync with the handle — and contradicted the best-effort
   * write policy every other path follows.
   */
  it('notifies subscribers of new tools even when the cache write fails', async () => {
    let calls = 0;
    state.listTools = () => {
      calls += 1;
      return Promise.resolve({
        tools:
          calls === 1
            ? []
            : [
                {
                  name: 'brand_new',
                  inputSchema: {
                    type: 'object',
                    properties: {},
                  },
                },
              ],
      });
    };

    const failingStore = {
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error('store unavailable')),
      delete: () => Promise.resolve(),
    };
    const handle = await createMCPTools({
      url: 'https://mcp.example.com/mcp',
      cache: {
        store: failingStore,
        key: 'k',
      },
    });

    const seen: number[] = [];
    handle.onToolsChanged((next) => {
      seen.push(next.length);
    });

    state.listChangedHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The write failed, the re-list did not: subscribers hear about the new set.
    expect(seen).toEqual([
      1,
    ]);
    expect(handle.tools).toHaveLength(1);
  });

  /**
   * A failure while BUILDING the snapshot must not wear the cache-write tag.
   *
   * `snapshot()` awaits the caller's own OAuth `provider.tokens()`, so a
   * provider rejection is a credential problem, not a store outage. Wrapping
   * the build inside the same `try` as `store.set` relabelled it
   * `MCPCacheWriteError` — the one class every path is documented to treat as
   * harmless — so callers following that pattern silently swallowed genuine
   * credential failures. `refresh()` must surface it under its own identity.
   */
  it('does not relabel a snapshot-build failure as MCPCacheWriteError', async () => {
    const { MCPCacheWriteError } = await import('../../../src/mcp/errors.js');
    const providerFailure = new Error('provider token refresh failed');
    const sets: unknown[] = [];
    const store = {
      get: () => Promise.resolve(null),
      set: (_key: string, value: unknown) => {
        sets.push(value);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    const handle = await createMCPTools({
      url: 'https://mcp.example.com/mcp',
      cacheCredentials: true,
      cache: {
        store,
        key: 'k',
      },
      auth: {
        kind: 'oauth',
        provider: {
          // Fails on the refresh() below. The construction write is
          // best-effort, so the first failure is swallowed by design; the
          // explicit refresh must then report the provider's own error.
          tokens: () => Promise.reject(providerFailure),
        } as never,
      },
    });

    let caught: unknown;
    try {
      await handle.refresh();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(providerFailure);
    expect(caught).not.toBeInstanceOf(MCPCacheWriteError);
    // And nothing was written with a half-built payload.
    expect(sets).toHaveLength(0);
  });

  /**
   * Announcement is keyed on ADOPTION, not on error class.
   *
   * `refresh()` can fail after swapping `tools` for reasons other than the
   * store op — `snapshot()` awaits the caller's OAuth `provider.tokens()`,
   * which propagates untagged (deliberately: it is a credential failure, not a
   * store outage). Subscribers must still hear about the adopted set, or they
   * are permanently out of sync with `handle.tools`.
   */
  it('notifies subscribers when a post-re-list snapshot build fails untagged', async () => {
    let calls = 0;
    state.listTools = () => {
      calls += 1;
      return Promise.resolve({
        tools:
          calls === 1
            ? []
            : [
                {
                  name: 'brand_new',
                  inputSchema: {
                    type: 'object',
                    properties: {},
                  },
                },
              ],
      });
    };

    let tokenCalls = 0;
    const handle = await createMCPTools({
      url: 'https://mcp.example.com/mcp',
      cacheCredentials: true,
      cache: {
        store: {
          get: () => Promise.resolve(null),
          set: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        },
        key: 'k',
      },
      auth: {
        kind: 'oauth',
        provider: {
          // Succeeds for the construction write, fails during the
          // list_changed-triggered refresh — after the new tools were adopted.
          tokens: () => {
            tokenCalls += 1;
            return tokenCalls === 1
              ? Promise.resolve({
                  access_token: 't1',
                  token_type: 'bearer',
                })
              : Promise.reject(new Error('provider outage'));
          },
        } as never,
      },
    });

    const seen: number[] = [];
    handle.onToolsChanged((next) => {
      seen.push(next.length);
    });

    state.listChangedHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The snapshot build failed untagged, but the re-list succeeded and the
    // handle adopted the new set — subscribers hear about it.
    expect(seen).toEqual([
      1,
    ]);
    expect(handle.tools).toHaveLength(1);
  });

  /**
   * A store outage on the READ is a miss, not a failure.
   *
   * The write side became best-effort everywhere in this PR; leaving the read
   * fatal meant "a store outage leaves you with a working handle" only held if
   * the outage arrived after the lookup. A failing `store.get` now falls through
   * to a fresh connect, exactly as a plain miss would.
   */
  it('treats a failing cache read as a miss and connects fresh', async () => {
    const brokenStore = {
      get: () => Promise.reject(new Error('store unavailable')),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };

    const handle = await createMCPTools({
      url: 'https://mcp.example.com/mcp',
      cache: {
        store: brokenStore,
        key: 'k',
      },
    });

    // Fresh connect succeeded despite the unreadable cache.
    expect(handle.tools).toHaveLength(0);
  });

  it('does not notify subscribers when the re-list itself fails', async () => {
    let calls = 0;
    state.listTools = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          tools: [],
        });
      }
      return Promise.reject(new Error('server gone'));
    };

    const handle = await createMCPTools({
      url: 'https://mcp.example.com/mcp',
    });
    const seen: number[] = [];
    handle.onToolsChanged((next) => {
      seen.push(next.length);
    });

    state.listChangedHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Tools were never swapped, so silence is correct here.
    expect(seen).toEqual([]);
    expect(handle.tools).toHaveLength(0);
  });

  /**
   * A custom cache key (e.g. `mcp:${userId}`) can outlive the URL it was written
   * for. Replaying such an entry would dial the OLD server with the NEW server's
   * credentials, so a URL mismatch must be a miss that connects to the requested
   * URL and overwrites the entry.
   */
  it('treats a snapshot for a different URL as a miss and never dials it', async () => {
    const { InMemoryMCPCacheStore } = await import('../../../src/mcp/cache/cache-store.js');
    const store = new InMemoryMCPCacheStore();
    const oldUrl = 'https://old.example.com/mcp';
    const newUrl = 'https://new.example.com/mcp';
    store.set('mcp:user-123', {
      version: 1,
      url: oldUrl,
      transport: 'streamableHttp',
      tools: [],
      cachedAt: Date.now(),
    });

    await createMCPTools({
      url: newUrl,
      auth: {
        kind: 'bearer',
        token: 'new-server-token',
      },
      cache: {
        store,
        key: 'mcp:user-123',
      },
    });

    expect(state.connectedUrls).toEqual([
      newUrl,
    ]);
    expect(store.get('mcp:user-123')?.url).toBe(newUrl);
  });

  it('still replays a snapshot whose URL matches the requested URL', async () => {
    const { InMemoryMCPCacheStore } = await import('../../../src/mcp/cache/cache-store.js');
    const store = new InMemoryMCPCacheStore();
    const url = 'https://mcp.example.com/mcp';
    store.set('k', {
      version: 1,
      url,
      transport: 'streamableHttp',
      tools: [
        {
          name: 'cached_tool',
          inputSchema: {
            type: 'object',
          },
        },
      ],
      cachedAt: Date.now(),
    });
    state.listTools = () => Promise.reject(new Error('listTools must not run on a replay'));

    const handle = await createMCPTools({
      url,
      auth: {
        kind: 'bearer',
        token: 't',
      },
      cache: {
        store,
        key: 'k',
      },
    });

    expect(state.connectedUrls).toEqual([
      url,
    ]);
    expect(handle.tools).toHaveLength(1);
  });

  it('still replays when the requested URL is an equivalent spelling of the cached one', async () => {
    const { InMemoryMCPCacheStore } = await import('../../../src/mcp/cache/cache-store.js');
    const store = new InMemoryMCPCacheStore();
    store.set('k', {
      version: 1,
      url: 'https://mcp.example.com/mcp',
      transport: 'streamableHttp',
      tools: [
        {
          name: 'cached_tool',
          inputSchema: {
            type: 'object',
          },
        },
      ],
      cachedAt: Date.now(),
    });
    state.listTools = () => Promise.reject(new Error('listTools must not run on a replay'));

    const handle = await createMCPTools({
      url: 'HTTPS://MCP.EXAMPLE.COM:443/mcp',
      auth: {
        kind: 'bearer',
        token: 't',
      },
      cache: {
        store,
        key: 'k',
      },
    });

    expect(handle.tools).toHaveLength(1);
  });

  it('treats a cached entry with an unparseable URL as a miss', async () => {
    const { InMemoryMCPCacheStore } = await import('../../../src/mcp/cache/cache-store.js');
    const store = new InMemoryMCPCacheStore();
    const url = 'https://mcp.example.com/mcp';
    store.set('k', {
      version: 1,
      url: 'not a url',
      transport: 'streamableHttp',
      tools: [],
      cachedAt: Date.now(),
    });

    await createMCPTools({
      url,
      cache: {
        store,
        key: 'k',
      },
    });

    expect(state.connectedUrls).toEqual([
      url,
    ]);
    expect(store.get('k')?.url).toBe(url);
  });

  /**
   * An old-URL entry that carries cached credentials must not lend them to the
   * new URL either: with no caller auth, the miss connects to the requested URL
   * unauthenticated rather than reusing the old server's secret.
   */
  it("does not reuse an old URL entry's cached credentials for a new URL", async () => {
    const { InMemoryMCPCacheStore } = await import('../../../src/mcp/cache/cache-store.js');
    const store = new InMemoryMCPCacheStore();
    const newUrl = 'https://new.example.com/mcp';
    store.set('mcp:user-123', {
      version: 1,
      url: 'https://old.example.com/mcp',
      transport: 'streamableHttp',
      tools: [],
      auth: {
        headers: {
          Authorization: 'Bearer old-server-token',
        },
      },
      cachedAt: Date.now(),
    });

    await createMCPTools({
      url: newUrl,
      cacheCredentials: true,
      cache: {
        store,
        key: 'mcp:user-123',
      },
    });

    expect(state.connectedUrls).toEqual([
      newUrl,
    ]);
    expect(state.connectedAuth).toEqual([
      undefined,
    ]);
  });

  /**
   * Two servers sharing one custom key: a call for A passes the URL check on its
   * first read, then a concurrent call for B rewrites the key before A's
   * credential graft reads back. A's credentials must not be grafted onto B's
   * entry, or B's next credential-bearing rehydrate would dial B with them.
   */
  it('does not graft credentials onto an entry rewritten for another URL mid-replay', async () => {
    const urlA = 'https://a.example.com/mcp';
    const urlB = 'https://b.example.com/mcp';
    const entryFor = (url: string, token: string): SerializedMCPServer => ({
      version: 1,
      url,
      transport: 'streamableHttp',
      tools: [],
      auth: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      cachedAt: Date.now(),
    });
    let reads = 0;
    const writes: unknown[] = [];
    const racingStore = {
      // First read (the cache-hit lookup) sees A; the graft's read-back sees B.
      get: () => {
        reads += 1;
        return reads === 1 ? entryFor(urlA, 'A-old') : entryFor(urlB, 'B-secret');
      },
      set: (_key: string, value: unknown) => {
        writes.push(value);
      },
      delete: () => {},
    };

    await createMCPTools({
      url: urlA,
      auth: {
        kind: 'bearer',
        token: 'A-new',
      },
      cacheCredentials: true,
      cache: {
        store: racingStore,
        key: 'mcp:user-123',
      },
    });

    expect(state.connectedUrls).toEqual([
      urlA,
    ]);
    expect(writes).toHaveLength(0);
  });
});

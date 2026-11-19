import { beforeEach, describe, expect, it, vi } from 'vitest';

// Which transport a warm cache dials. These run the real `createMCPTools`,
// `rehydrateMCPTools` and `connect()` — only the SDK is faked — because the bug
// lived in how those three compose: a pinned transport disables the Streamable
// HTTP -> SSE ladder inside `connect()`, and the cache was pinning it. A mocked
// `connect` would have to re-implement that ladder to show anything.

type Kind = 'streamableHttp' | 'sse';

const KIND = Symbol('transport-kind');

interface FakeSdkState {
  /** Transport of every `client.connect()` attempt, in order. */
  attempts: Kind[];
  /** Transports the fake server no longer accepts. */
  gone: Set<Kind>;
}

const sdk: FakeSdkState = {
  attempts: [],
  gone: new Set(),
};

vi.mock('@modelcontextprotocol/client', () => ({
  UnauthorizedError: class extends Error {},
  StreamableHTTPClientTransport: class {
    [KIND] = 'streamableHttp' as const;
    sessionId: string | undefined = undefined;
  },
  SSEClientTransport: class {
    [KIND] = 'sse' as const;
  },
  Client: class {
    setRequestHandler(): void {}
    setNotificationHandler(): void {}
    connect(transport: { [KIND]: Kind }): Promise<void> {
      const kind = transport[KIND];
      sdk.attempts.push(kind);
      return sdk.gone.has(kind)
        ? Promise.reject(new Error(`${kind} endpoint is gone (404)`))
        : Promise.resolve();
    }
    getProtocolEra(): 'legacy' {
      return 'legacy';
    }
    getServerVersion(): undefined {
      return undefined;
    }
    getServerCapabilities(): undefined {
      return undefined;
    }
    listTools(): Promise<{
      tools: {
        name: string;
        inputSchema: Record<string, unknown>;
      }[];
    }> {
      return Promise.resolve({
        tools: [
          {
            name: 'a',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      });
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const { createMCPTools } = await import('../../../src/mcp/create-mcp-tools.js');
const { rehydrateMCPTools } = await import('../../../src/mcp/rehydrate.js');
const { defaultCacheKey, InMemoryMCPCacheStore } = await import(
  '../../../src/mcp/cache/cache-store.js'
);
const { MCPCacheError, MCPConnectionError } = await import('../../../src/mcp/errors.js');
type InMemoryStore = InstanceType<typeof InMemoryMCPCacheStore>;

const URL_ = 'https://mcp.example.com/mcp';

/** Passed on every call: a snapshot without credentials is never replayed. */
const AUTH = {
  kind: 'bearer',
  token: 't',
} as const;

/**
 * A store holding the entry a cold connect writes after falling back to SSE —
 * produced by a real cold connect against a server with no Streamable HTTP
 * endpoint, not hand-written.
 */
async function storeWithSseEntry(): Promise<InMemoryStore> {
  const store = new InMemoryMCPCacheStore();
  sdk.gone = new Set([
    'streamableHttp',
  ]);
  const cold = await createMCPTools({
    url: URL_,
    auth: AUTH,
    cache: {
      store,
    },
  });
  await cold.close();
  expect(storedTransport(store)).toBe('sse');
  sdk.gone = new Set();
  sdk.attempts = [];
  return store;
}

function storedTransport(store: InMemoryStore): Kind | undefined {
  return store.get(defaultCacheKey(URL_))?.transport;
}

beforeEach(() => {
  sdk.attempts = [];
  sdk.gone = new Set();
});

describe('a warm cache whose recorded transport the server has since dropped', () => {
  it('falls back to the transport ladder and records the transport that worked', async () => {
    const store = await storeWithSseEntry();
    // The server migrates: SSE is removed, Streamable HTTP now works.
    sdk.gone = new Set([
      'sse',
    ]);

    const warm = await createMCPTools({
      url: URL_,
      auth: AUTH,
      cache: {
        store,
      },
    });

    // The replay dials the recorded transport — twice, because the implicit
    // legacy retry re-walks a pinned transport — then the fallback starts from
    // the top of the ladder instead of dialling SSE again.
    expect(sdk.attempts).toEqual([
      'sse',
      'sse',
      'streamableHttp',
    ]);
    expect(warm.tools).toHaveLength(1);
    expect(storedTransport(store)).toBe('streamableHttp');
    await warm.close();

    // Self-healed: the next warm call replays over the new transport directly.
    sdk.attempts = [];
    const next = await createMCPTools({
      url: URL_,
      auth: AUTH,
      cache: {
        store,
      },
    });
    expect(sdk.attempts).toEqual([
      'streamableHttp',
    ]);
    await next.close();
  });

  it('heals a direct rehydrateMCPTools call the same way', async () => {
    const store = await storeWithSseEntry();
    const snapshot = store.get(defaultCacheKey(URL_));
    if (snapshot === null) {
      throw new Error('expected a stored snapshot');
    }
    sdk.gone = new Set([
      'sse',
    ]);

    const handle = await rehydrateMCPTools({
      snapshot,
      auth: AUTH,
      cache: {
        store,
      },
    });

    expect(sdk.attempts.at(-1)).toBe('streamableHttp');
    expect(storedTransport(store)).toBe('streamableHttp');
    await handle.close();
  });

  it('rejects without trying another transport when reconnectOnExpiry is false', async () => {
    const store = await storeWithSseEntry();
    const snapshot = store.get(defaultCacheKey(URL_));
    if (snapshot === null) {
      throw new Error('expected a stored snapshot');
    }
    sdk.gone = new Set([
      'sse',
    ]);

    // Declining the fallback declines the ladder with it: the recorded
    // transport is all the replay has.
    await expect(
      rehydrateMCPTools({
        snapshot,
        auth: AUTH,
        reconnectOnExpiry: false,
      }),
    ).rejects.toThrow(MCPCacheError);
    expect(new Set(sdk.attempts)).toEqual(
      new Set([
        'sse',
      ]),
    );

    // The way out without a fallback is to name the transport.
    sdk.attempts = [];
    const handle = await rehydrateMCPTools({
      snapshot,
      auth: AUTH,
      reconnectOnExpiry: false,
      transport: 'streamableHttp',
    });
    expect(sdk.attempts).toEqual([
      'streamableHttp',
    ]);
    await handle.close();
  });
});

describe("the caller's transport on a cache hit", () => {
  it('overrides the transport recorded in the snapshot', async () => {
    const store = await storeWithSseEntry();

    const warm = await createMCPTools({
      url: URL_,
      auth: AUTH,
      transport: 'streamableHttp',
      cache: {
        store,
      },
    });

    expect(sdk.attempts).toEqual([
      'streamableHttp',
    ]);
    expect((await warm.serialize()).transport).toBe('streamableHttp');
    await warm.close();
  });

  it('stays pinned through the fresh-connect fallback', async () => {
    const store = await storeWithSseEntry();
    // SSE would work; the caller asked for Streamable HTTP, which does not.
    sdk.gone = new Set([
      'streamableHttp',
    ]);

    await expect(
      createMCPTools({
        url: URL_,
        auth: AUTH,
        transport: 'streamableHttp',
        cache: {
          store,
        },
      }),
    ).rejects.toThrow(MCPConnectionError);

    // A pin means that transport's failures too — never a quiet switch to SSE.
    expect(sdk.attempts).not.toContain('sse');
    expect(storedTransport(store)).toBe('sse');
  });

  it('uses the recorded transport when the caller names none', async () => {
    const store = await storeWithSseEntry();

    const warm = await createMCPTools({
      url: URL_,
      auth: AUTH,
      cache: {
        store,
      },
    });

    // The hint is worth keeping: one dial, no wasted Streamable HTTP attempt.
    expect(sdk.attempts).toEqual([
      'sse',
    ]);
    await warm.close();
  });
});

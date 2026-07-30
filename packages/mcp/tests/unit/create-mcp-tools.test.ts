import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectOptions, MCPConnection } from '../../src/mcp-connection.js';

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
}

const state: FakeState = {
  listTools: () =>
    Promise.resolve({
      tools: [],
    }),
  closed: 0,
  listChangedHandler: undefined,
};

vi.mock('../../src/mcp-connection.js', () => ({
  connect: (_options: ConnectOptions): Promise<MCPConnection> => {
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

const { createMCPTools } = await import('../../src/create-mcp-tools.js');

describe('createMCPTools setup teardown', () => {
  beforeEach(() => {
    state.closed = 0;
    state.listChangedHandler = undefined;
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
      get: () => Promise.resolve(undefined),
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
});

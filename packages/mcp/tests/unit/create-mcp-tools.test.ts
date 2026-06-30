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
});

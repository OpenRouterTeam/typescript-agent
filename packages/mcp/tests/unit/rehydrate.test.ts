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

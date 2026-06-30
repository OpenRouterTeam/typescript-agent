import { describe, expect, it, vi } from 'vitest';
import type { ConnectOptions, MCPConnection } from '../../src/mcp-connection.js';

// Pages of tools the fake client serves, one cursor at a time. Captured so the
// test can assert which cursors freshConnect requested.
interface ToolPage {
  tools: {
    name: string;
    inputSchema: {
      type: 'object';
      properties: object;
    };
  }[];
  nextCursor?: string;
}

const listToolsCursors: (string | undefined)[] = [];

const toolPages: ToolPage[] = [
  {
    tools: [
      {
        name: 'alpha',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
    nextCursor: 'page-2',
  },
  {
    tools: [
      {
        name: 'beta',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
    // No nextCursor -> last page.
  },
];

vi.mock('../../src/mcp-connection.js', () => ({
  connect: (_options: ConnectOptions): Promise<MCPConnection> => {
    let idx = 0;
    const connection: MCPConnection = {
      client: {
        listTools: (params?: { cursor?: string }) => {
          listToolsCursors.push(params?.cursor);
          const page = toolPages[idx] ?? {
            tools: [],
          };
          idx += 1;
          return Promise.resolve(page);
        },
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

const { freshConnect } = await import('../../src/handle.js');

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

describe('listToolDefs pagination (via freshConnect)', () => {
  it('discovers tools across every page following nextCursor', async () => {
    listToolsCursors.length = 0;
    const handle = await freshConnect(
      {
        url: 'https://mcp.example.com/mcp',
      },
      new URL('https://mcp.example.com/mcp'),
      'test-key',
    );
    const names = handle.tools.map(nameOf);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    // First page requested without a cursor, second following nextCursor.
    expect(listToolsCursors).toEqual([
      undefined,
      'page-2',
    ]);
  });
});

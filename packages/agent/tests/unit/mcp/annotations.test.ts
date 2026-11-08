/**
 * A server's `tools/list` annotations must survive discovery: a consumer reads
 * them off the wrapped tool (for example to decide which calls need approval),
 * and a cache snapshot has to restore the same hints it was written with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedMCPServer } from '../../../src/mcp/cache/cache-types.js';
import type { ConnectOptions, MCPConnection } from '../../../src/mcp/mcp-connection.js';

type ListedTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

const INPUT_SCHEMA = {
  type: 'object',
  properties: {},
};

/** What a consumer must read back for the tools `beforeEach` lists. */
const REPORTED = {
  search: {
    title: 'Search',
    readOnlyHint: true,
    openWorldHint: false,
  },
  delete_record: {
    destructiveHint: true,
  },
  unannotated: undefined,
};

let listedTools: ListedTool[] = [];
let listToolsCalls = 0;

vi.mock('../../../src/mcp/mcp-connection.js', () => ({
  connect: (_options: ConnectOptions): Promise<MCPConnection> => {
    const connection: MCPConnection = {
      client: {
        getServerVersion: () => undefined,
        getServerCapabilities: () => undefined,
        listTools: () => {
          listToolsCalls += 1;
          return Promise.resolve({
            tools: listedTools,
          });
        },
      } as never,
      transport: 'streamableHttp',
      setToolListChangedHandler: () => {},
      close: () => Promise.resolve(),
    };
    return Promise.resolve(connection);
  },
}));

const { createMCPTools } = await import('../../../src/mcp/create-mcp-tools.js');
const { rehydrateMCPTools } = await import('../../../src/mcp/rehydrate.js');
const { isSerializedMCPServer } = await import('../../../src/mcp/cache/cache-types.js');
const { isMcpTool } = await import('../../../src/lib/tool-types.js');

function annotationsByName(
  tools: readonly import('../../../src/lib/tool-types.js').Tool[],
): Record<string, unknown> {
  return Object.fromEntries(
    tools.flatMap((tool) =>
      isMcpTool(tool) && 'function' in tool
        ? [
            [
              tool.function.name,
              tool.annotations,
            ],
          ]
        : [],
    ),
  );
}

function snapshotWith(annotations: unknown): unknown {
  return {
    version: 1,
    url: 'https://mcp.example.com/mcp',
    transport: 'streamableHttp',
    tools: [
      {
        name: 'delete_record',
        inputSchema: INPUT_SCHEMA,
        annotations,
      },
    ],
    cachedAt: 1234,
  };
}

describe('MCP tool annotations', () => {
  beforeEach(() => {
    listToolsCalls = 0;
    listedTools = [
      {
        name: 'search',
        inputSchema: INPUT_SCHEMA,
        annotations: {
          title: 'Search',
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'delete_record',
        inputSchema: INPUT_SCHEMA,
        annotations: {
          destructiveHint: true,
        },
      },
      {
        name: 'unannotated',
        inputSchema: INPUT_SCHEMA,
      },
    ];
  });

  it('exposes each tool with the hints its server reported, and none when it reported none', async () => {
    const handle = await createMCPTools({
      url: 'https://mcp.example.com/mcp',
      resources: false,
    });

    expect(annotationsByName(handle.tools)).toEqual(REPORTED);
  });

  it('restores the same hints from a snapshot without listing the tools again', async () => {
    const live = await createMCPTools({
      url: 'https://mcp.example.com/mcp',
      resources: false,
    });
    const snapshot: SerializedMCPServer = JSON.parse(JSON.stringify(await live.serialize()));
    listToolsCalls = 0;

    const replayed = await rehydrateMCPTools({
      snapshot,
      reconnectOnExpiry: false,
      resources: false,
    });

    expect(listToolsCalls).toBe(0);
    expect(annotationsByName(replayed.tools)).toEqual(REPORTED);
  });

  it.each([
    [
      'a hint that is not a boolean',
      {
        readOnlyHint: 'false',
      },
    ],
    [
      'a title that is not a string',
      {
        title: 7,
      },
    ],
    [
      'a non-object',
      true,
    ],
  ])('rejects a snapshot whose annotations hold %s', (_label, annotations) => {
    expect(isSerializedMCPServer(snapshotWith(annotations))).toBe(false);
  });

  it('accepts a snapshot whose annotations are well-formed', () => {
    expect(
      isSerializedMCPServer(
        snapshotWith({
          readOnlyHint: false,
        }),
      ),
    ).toBe(true);
  });
});

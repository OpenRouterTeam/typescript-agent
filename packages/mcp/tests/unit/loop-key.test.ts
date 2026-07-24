/**
 * Tests for doom-loop `loopKey` support on MCP-wrapped tools.
 *
 * Coverage:
 * - client-side `loopKeys` config attaches an identity to a wrapped tool
 *   (keyed by UNPREFIXED MCP name, all three ToolLoopKey forms)
 * - server-advertised `_meta['openrouter/loopKey']` (field list or `false`)
 *   lands on the tool definition and the wrapped tool
 * - client config takes precedence over the server declaration
 * - the declaration round-trips through the cache snapshot
 *   (serialize → rehydrate's snapshotToToolDefs)
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import { buildTools } from '../../src/build-tools.js';
import { isSerializedMCPServer } from '../../src/cache/cache-types.js';
import { serializeServer } from '../../src/cache/serialize.js';
import { listToolDefs } from '../../src/handle.js';
import type { MCPConnection } from '../../src/mcp-connection.js';
import type { McpToolDef } from '../../src/tool-wrapper.js';
import { wrapMcpTool } from '../../src/tool-wrapper.js';

function fakeClient(): Client {
  return {} as never;
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

const bashDef: McpToolDef = {
  name: 'run_command',
  description: 'Run a shell command.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
      },
      cwd: {
        type: 'string',
      },
    },
  },
};

describe('wrapMcpTool loopKey', () => {
  it('attaches a client-configured field-list identity', () => {
    const wrapped = wrapMcpTool(bashDef, {
      client: fakeClient(),
      loopKeys: {
        run_command: [
          'command',
          'cwd',
        ],
      },
    });
    expect(loopKeyOf(wrapped)).toEqual([
      'command',
      'cwd',
    ]);
  });

  it('attaches a client-configured function identity', () => {
    const fn = (args: Record<string, unknown>) => args['command'];
    const wrapped = wrapMcpTool(bashDef, {
      client: fakeClient(),
      loopKeys: {
        run_command: fn,
      },
    });
    expect(loopKeyOf(wrapped)).toBe(fn);
  });

  it('attaches a client-configured false (exempt)', () => {
    const wrapped = wrapMcpTool(bashDef, {
      client: fakeClient(),
      loopKeys: {
        run_command: false,
      },
    });
    expect(loopKeyOf(wrapped)).toBe(false);
  });

  it('keys loopKeys by the UNPREFIXED MCP name', () => {
    const wrapped = wrapMcpTool(bashDef, {
      client: fakeClient(),
      namePrefix: 'svc_',
      loopKeys: {
        run_command: [
          'command',
        ],
      },
    });
    expect(loopKeyOf(wrapped)).toEqual([
      'command',
    ]);
  });

  it('uses the server-advertised declaration when no client config exists', () => {
    const wrapped = wrapMcpTool(
      {
        ...bashDef,
        loopKey: [
          'command',
        ],
      },
      {
        client: fakeClient(),
      },
    );
    expect(loopKeyOf(wrapped)).toEqual([
      'command',
    ]);
  });

  it('client config takes precedence over the server declaration', () => {
    const wrapped = wrapMcpTool(
      {
        ...bashDef,
        loopKey: [
          'command',
        ],
      },
      {
        client: fakeClient(),
        loopKeys: {
          run_command: false,
        },
      },
    );
    expect(loopKeyOf(wrapped)).toBe(false);
  });

  it('attaches on generator (emitProgress) tools too', () => {
    const wrapped = wrapMcpTool(bashDef, {
      client: fakeClient(),
      emitProgress: true,
      loopKeys: {
        run_command: [
          'command',
        ],
      },
    });
    expect(loopKeyOf(wrapped)).toEqual([
      'command',
    ]);
  });

  it('leaves loopKey absent when neither source declares one', () => {
    const wrapped = wrapMcpTool(bashDef, {
      client: fakeClient(),
    });
    expect(loopKeyOf(wrapped)).toBeUndefined();
  });
});

describe('buildTools loopKeys plumbing', () => {
  it('threads loopKeys through to wrapped tools', () => {
    const tools = buildTools({
      client: fakeClient(),
      toolDefs: [
        bashDef,
      ],
      namePrefix: 'svc_',
      serverHasResources: false,
      loopKeys: {
        run_command: [
          'command',
          'cwd',
        ],
      },
    });
    expect(loopKeyOf(tools[0])).toEqual([
      'command',
      'cwd',
    ]);
  });
});

describe('server-advertised loopKey validation', () => {
  it.each([
    [
      'truthy scalar',
      'loop',
    ],
    [
      'mixed-type array',
      [
        'command',
        1,
      ],
    ],
    [
      'nested object',
      {
        fields: [
          'command',
        ],
      },
    ],
    [
      'missing metadata',
      undefined,
    ],
  ])('ignores invalid or missing metadata: %s', async (_label, loopKey) => {
    const connection = {
      client: {
        listTools: () =>
          Promise.resolve({
            tools: [
              {
                name: 'run_command',
                inputSchema: {
                  type: 'object',
                  properties: {},
                },
                ...(loopKey !== undefined && {
                  _meta: {
                    'openrouter/loopKey': loopKey,
                  },
                }),
              },
            ],
          }),
      },
    } as unknown as MCPConnection;

    const [tool] = await listToolDefs(connection, undefined);
    expect(tool?.loopKey).toBeUndefined();
  });
});

describe('cache round-trip', () => {
  it('serializes a server-advertised loopKey and restores it on rehydrate', async () => {
    const snapshot = await serializeServer({
      url: 'https://example.com/mcp',
      transport: 'streamableHttp',
      toolDefs: [
        {
          ...bashDef,
          loopKey: [
            'command',
            'cwd',
          ],
        },
        {
          name: 'poll_job',
          inputSchema: {
            type: 'object',
            properties: {},
          },
          loopKey: false,
        },
      ],
      cacheCredentials: false,
      cachedAt: 1234,
    });

    expect(snapshot.tools[0]?.loopKey).toEqual([
      'command',
      'cwd',
    ]);
    expect(snapshot.tools[1]?.loopKey).toBe(false);

    // JSON round-trip (cache stores persist JSON) preserves the declaration.
    const revived = JSON.parse(JSON.stringify(snapshot));
    expect(revived.tools[0].loopKey).toEqual([
      'command',
      'cwd',
    ]);
    expect(revived.tools[1].loopKey).toBe(false);
  });

  it.each([
    [
      'truthy scalar',
      'loop',
    ],
    [
      'mixed-type array',
      [
        'command',
        1,
      ],
    ],
    [
      'nested object',
      {
        fields: [
          'command',
        ],
      },
    ],
  ])('rejects invalid cached loopKey: %s', (_label, loopKey) => {
    expect(
      isSerializedMCPServer({
        version: 1,
        url: 'https://example.com/mcp',
        transport: 'streamableHttp',
        cachedAt: 1234,
        tools: [
          {
            name: 'run_command',
            inputSchema: {
              type: 'object',
            },
            loopKey,
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts a cached tool with missing loopKey metadata', () => {
    expect(
      isSerializedMCPServer({
        version: 1,
        url: 'https://example.com/mcp',
        transport: 'streamableHttp',
        cachedAt: 1234,
        tools: [
          {
            name: 'run_command',
            inputSchema: {
              type: 'object',
            },
          },
        ],
      }),
    ).toBe(true);
  });
});

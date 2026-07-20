import { describe, expect, it } from 'vitest';
import { buildTools, filterToolDefs } from '../../src/build-tools.js';
import { MCPError } from '../../src/errors.js';
import type { McpToolDef } from '../../src/tool-wrapper.js';

// A minimal stand-in for the MCP Client; buildTools only stores the reference
// for the wrapped tools' execute closures, which these tests don't invoke.
function fakeClient(): import('@modelcontextprotocol/sdk/client/index.js').Client {
  return {} as never;
}

const defs: McpToolDef[] = [
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
];

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

describe('filterToolDefs', () => {
  it('applies an allow-list', () => {
    expect(
      filterToolDefs(defs, [
        'alpha',
      ]).map((d) => d.name),
    ).toEqual([
      'alpha',
    ]);
  });
  it('applies a deny-list', () => {
    expect(
      filterToolDefs(defs, undefined, [
        'alpha',
      ]).map((d) => d.name),
    ).toEqual([
      'beta',
    ]);
  });
});

describe('buildTools', () => {
  it('wraps tools and applies a name prefix', () => {
    const tools = buildTools({
      client: fakeClient(),
      toolDefs: defs,
      namePrefix: 'svc_',
      serverHasResources: false,
    });
    expect(tools.map(nameOf)).toEqual([
      'svc_alpha',
      'svc_beta',
    ]);
  });

  it('adds synthetic resource tools when the server supports resources', () => {
    const tools = buildTools({
      client: fakeClient(),
      toolDefs: defs,
      serverHasResources: true,
    });
    expect(tools.map(nameOf)).toContain('list_resources');
    expect(tools.map(nameOf)).toContain('read_resource');
  });

  it('omits resource tools when disabled', () => {
    const tools = buildTools({
      client: fakeClient(),
      toolDefs: defs,
      serverHasResources: true,
      resources: false,
    });
    expect(tools.map(nameOf)).not.toContain('list_resources');
  });

  it('throws on a duplicate tool name', () => {
    const dup: McpToolDef[] = [
      {
        name: 'same',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'same',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
    expect(() =>
      buildTools({
        client: fakeClient(),
        toolDefs: dup,
        serverHasResources: false,
      }),
    ).toThrow(MCPError);
  });
});

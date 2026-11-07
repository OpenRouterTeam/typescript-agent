import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { convertToolsToAPIFormat, validateToolInput } from '../../../src/lib/tool-executor.js';
import { isClientTool } from '../../../src/lib/tool-types.js';
import type { McpToolDef } from '../../../src/mcp/tool-wrapper.js';
import { wrapMcpTool } from '../../../src/mcp/tool-wrapper.js';

// wrapMcpTool only stores the client for the execute closure, which these
// tests never invoke.
function fakeClient(): Client {
  return {} as never;
}

function wireParameters(def: McpToolDef): unknown {
  const [emitted] = convertToolsToAPIFormat([
    wrapMcpTool(def, {
      client: fakeClient(),
    }),
  ]);
  return emitted !== undefined && 'parameters' in emitted ? emitted.parameters : undefined;
}

describe('MCP tool wire input schema', () => {
  it("sends the server's schema to the model unchanged", () => {
    // Each of these is rewritten by a JSON Schema -> Zod -> JSON Schema round
    // trip: `format` gains a `pattern`, `integer` gains safe-integer bounds,
    // `$ref`/`$defs` are inlined, `prefixItems` becomes draft-07 `items`, and
    // an open object gains `additionalProperties: {}`.
    const inputSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        when: {
          type: 'string',
          format: 'date-time',
        },
        count: {
          type: 'integer',
          minimum: 1,
        },
        point: {
          type: 'array',
          prefixItems: [
            {
              type: 'number',
            },
            {
              type: 'number',
            },
          ],
          items: false,
        },
        filter: {
          $ref: '#/$defs/Filter',
        },
      },
      required: [
        'when',
      ],
      $defs: {
        Filter: {
          type: 'object',
          properties: {
            tag: {
              type: 'string',
            },
          },
          additionalProperties: false,
        },
      },
    };

    expect(
      wireParameters({
        name: 'search',
        inputSchema,
      }),
    ).toEqual(inputSchema);
  });

  it('still validates call arguments against the converted Zod schema', () => {
    const wrapped = wrapMcpTool(
      {
        name: 'search',
        inputSchema: {
          type: 'object',
          properties: {
            count: {
              type: 'integer',
            },
          },
          required: [
            'count',
          ],
        },
      },
      {
        client: fakeClient(),
      },
    );
    if (!isClientTool(wrapped)) {
      throw new Error('expected a client tool');
    }
    const { inputSchema } = wrapped.function;

    expect(
      validateToolInput(inputSchema, {
        count: 2,
      }),
    ).toEqual({
      count: 2,
    });
    expect(() =>
      validateToolInput(inputSchema, {
        count: 'two',
      }),
    ).toThrow();
  });

  it('serializes the Zod-derived object schema when the server schema is not an object', () => {
    expect(
      wireParameters({
        name: 'odd',
        inputSchema: {
          type: 'string',
        },
      }),
    ).toMatchObject({
      type: 'object',
    });
  });
});

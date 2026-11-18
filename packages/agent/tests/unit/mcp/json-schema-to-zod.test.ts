import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { executeTool } from '../../../src/lib/tool-executor.js';
import { MCPError } from '../../../src/mcp/errors.js';
import { convertMcpInputSchema } from '../../../src/mcp/schema/json-schema-to-zod.js';
import { wrapMcpTool } from '../../../src/mcp/tool-wrapper.js';

describe('convertMcpInputSchema', () => {
  it('converts primitives, enums, and required fields faithfully', () => {
    const schema = convertMcpInputSchema({
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'city',
        },
        count: {
          type: 'integer',
          minimum: 1,
        },
        mode: {
          type: 'string',
          enum: [
            'a',
            'b',
          ],
        },
        verbose: {
          type: 'boolean',
        },
      },
      required: [
        'location',
      ],
    });

    expect(
      z.parse(schema, {
        location: 'NYC',
        count: 2,
        mode: 'a',
      }),
    ).toEqual({
      location: 'NYC',
      count: 2,
      mode: 'a',
    });
    // location is required
    expect(() =>
      z.parse(schema, {
        count: 1,
      }),
    ).toThrow();
    // enum is enforced
    expect(() =>
      z.parse(schema, {
        location: 'NYC',
        mode: 'c',
      }),
    ).toThrow();
  });

  it('handles nested objects and arrays', () => {
    const schema = convertMcpInputSchema({
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
        },
      },
    });
    expect(
      z.parse(schema, {
        filter: {
          tags: [
            'x',
            'y',
          ],
        },
      }),
    ).toEqual({
      filter: {
        tags: [
          'x',
          'y',
        ],
      },
    });
  });

  it('handles anyOf unions', () => {
    const schema = convertMcpInputSchema({
      type: 'object',
      properties: {
        value: {
          anyOf: [
            {
              type: 'string',
            },
            {
              type: 'number',
            },
          ],
        },
      },
      required: [
        'value',
      ],
    });
    expect(
      z.parse(schema, {
        value: 'a',
      }),
    ).toEqual({
      value: 'a',
    });
    expect(
      z.parse(schema, {
        value: 3,
      }),
    ).toEqual({
      value: 3,
    });
  });

  it('resolves $ref/$defs', () => {
    const schema = convertMcpInputSchema({
      type: 'object',
      properties: {
        item: {
          $ref: '#/$defs/Item',
        },
      },
      $defs: {
        Item: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
            },
          },
        },
      },
      required: [
        'item',
      ],
    });
    expect(
      z.parse(schema, {
        item: {
          id: '1',
        },
      }),
    ).toEqual({
      item: {
        id: '1',
      },
    });
  });

  it('produces an object schema for an empty-params tool', () => {
    const schema = convertMcpInputSchema({
      type: 'object',
      properties: {},
    });
    expect(schema._zod.def.type).toBe('object');
    expect(z.parse(schema, {})).toEqual({});
  });

  it('looseLeaf: relaxes only the unconvertible property, keeps siblings faithful', () => {
    const schema = convertMcpInputSchema({
      type: 'object',
      properties: {
        good: {
          type: 'string',
        },
        bad: {
          not: {
            type: 'string',
          },
        },
      },
      required: [
        'good',
      ],
    });
    // sibling still enforced
    expect(() =>
      z.parse(schema, {
        good: 123,
      }),
    ).toThrow();
    // unconvertible leaf accepts anything
    expect(
      z.parse(schema, {
        good: 'ok',
        bad: {
          anything: true,
        },
      }),
    ).toEqual({
      good: 'ok',
      bad: {
        anything: true,
      },
    });
  });

  it('throw mode: surfaces an MCPError on unconvertible schema', () => {
    expect(() =>
      convertMcpInputSchema(
        {
          type: 'object',
          properties: {
            bad: {
              not: {
                type: 'string',
              },
            },
          },
        },
        'throw',
      ),
    ).toThrow(MCPError);
  });
});

// The per-property fallback only knows the root-level `properties`. Since the
// model is sent the server's own schema, it sends arguments that schema allows
// — including ones declared in a composition branch — and a fallback that
// strips unknown keys would deliver `{}` (or a partial object) to the server.
// These run the wrapped tool through the real executor, so the assertion is on
// what `callTool` receives, not on the Zod schema in isolation.
describe('fallback conversion keeps the arguments the server schema allows', () => {
  interface Scenario {
    label: string;
    inputSchema: Record<string, unknown>;
    args: Record<string, unknown>;
  }

  const STRING = {
    type: 'string',
  };

  const scenarios: Scenario[] = [
    {
      label: 'a root oneOf with no root properties',
      inputSchema: {
        type: 'object',
        oneOf: [
          {
            properties: {
              id: STRING,
            },
            required: [
              'id',
            ],
          },
          {
            properties: {
              name: STRING,
            },
            required: [
              'name',
            ],
          },
        ],
      },
      args: {
        id: 'abc',
      },
    },
    {
      label: 'a root allOf',
      inputSchema: {
        type: 'object',
        allOf: [
          {
            properties: {
              id: STRING,
            },
          },
          {
            properties: {
              name: STRING,
            },
          },
        ],
      },
      args: {
        id: 'abc',
        name: 'n',
      },
    },
    {
      label: 'a root anyOf alongside root properties',
      inputSchema: {
        type: 'object',
        properties: {
          mode: STRING,
        },
        anyOf: [
          {
            properties: {
              id: STRING,
            },
            required: [
              'id',
            ],
          },
          {
            properties: {
              name: STRING,
            },
            required: [
              'name',
            ],
          },
        ],
      },
      args: {
        mode: 'm',
        id: 'abc',
      },
    },
    {
      label: 'an if/then that requires an undeclared property',
      inputSchema: {
        type: 'object',
        properties: {
          kind: STRING,
        },
        if: {
          properties: {
            kind: {
              const: 'a',
            },
          },
        },
        // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword under test
        then: {
          required: [
            'a_id',
          ],
        },
      },
      args: {
        kind: 'a',
        a_id: '1',
      },
    },
    {
      label: 'a draft-07 definitions $ref with an extra key',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            $ref: '#/definitions/Filter',
          },
        },
        definitions: {
          Filter: {
            type: 'object',
            properties: {
              field: STRING,
            },
          },
        },
      },
      args: {
        filter: {
          field: 'x',
        },
        other: 1,
      },
    },
  ];

  /** Run one tool call the way `callModel` does and report what the server saw. */
  async function callThroughExecutor(scenario: Scenario): Promise<{
    sent: unknown[];
    error: Error | undefined;
  }> {
    const sent: unknown[] = [];
    // Only `callTool` is reached: the wrapper stores the client for its
    // execute closure and touches nothing else.
    const client: Client = {
      callTool: (params: { arguments: unknown }) => {
        sent.push(params.arguments);
        return Promise.resolve({
          content: [
            {
              type: 'text',
              text: 'ok',
            },
          ],
        });
      },
    } as never;
    const wrapped = wrapMcpTool(
      {
        name: 'search',
        inputSchema: scenario.inputSchema,
      },
      {
        client,
        emitProgress: false,
      },
    );
    const result = await executeTool(
      wrapped,
      {
        id: 'call_1',
        name: 'search',
        arguments: scenario.args,
      },
      {
        numberOfTurns: 1,
      },
    );
    return {
      sent,
      error: result !== null && 'error' in result ? result.error : undefined,
    };
  }

  it.each(scenarios)('delivers every argument for $label', async (scenario) => {
    // Guard the premise: each of these must actually take the fallback, or the
    // test would pass on the holistic path and prove nothing about it.
    let holistic: string;
    try {
      holistic = z.fromJSONSchema(scenario.inputSchema)._zod.def.type;
    } catch {
      holistic = 'threw';
    }
    expect(holistic).not.toBe('object');

    const { sent, error } = await callThroughExecutor(scenario);

    expect(error).toBeUndefined();
    expect(sent).toEqual([
      scenario.args,
    ]);
  });

  it('still validates the root properties it does know about', async () => {
    const { sent, error } = await callThroughExecutor({
      label: 'a wrongly-typed root property',
      inputSchema: {
        type: 'object',
        properties: {
          mode: STRING,
        },
        anyOf: [
          {
            required: [
              'id',
            ],
          },
        ],
      },
      args: {
        mode: 7,
        id: 'abc',
      },
    });

    expect(error).toBeDefined();
    expect(sent).toEqual([]);
  });

  it('keeps structured output fields a fallback output schema does not list', () => {
    // Same converter, same hazard in the other direction: stripping here would
    // delete fields from `structuredContent` before the model sees them.
    const outputSchema = convertMcpInputSchema({
      type: 'object',
      oneOf: [
        {
          properties: {
            id: STRING,
          },
        },
        {
          properties: {
            error: STRING,
          },
        },
      ],
    });

    expect(
      z.parse(outputSchema, {
        id: '1',
      }),
    ).toEqual({
      id: '1',
    });
  });
});

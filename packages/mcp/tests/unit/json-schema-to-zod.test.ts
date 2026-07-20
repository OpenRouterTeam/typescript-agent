import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { MCPError } from '../../src/errors.js';
import { convertMcpInputSchema } from '../../src/schema/json-schema-to-zod.js';

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

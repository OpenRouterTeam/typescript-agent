/**
 * A JSON Schema combinator branch may leave out the `type` its enclosing
 * schema already states. Zod converts each branch on its own and reads such a
 * branch as "anything", so a `oneOf` of them rejected every call and an `anyOf`
 * of them accepted every call. These tests pin what a wrapped MCP tool accepts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { convertToolsToAPIFormat } from '../../../src/lib/tool-executor.js';
import { isClientTool } from '../../../src/lib/tool-types.js';
import { wrapMcpTool } from '../../../src/mcp/tool-wrapper.js';

/*
 * `tools/list` from https://catalog.shopify.com/api/ucp/mcp, captured
 * 2026-11-08: the `search_catalog` input schema, verbatim. `catalog.like`
 * items are a `oneOf` of two branches with no `type`, and `catalog` is an
 * `anyOf` of three.
 */
const SHOPIFY_SEARCH_CATALOG: Record<string, unknown> = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures/shopify-search-catalog-input-schema.json',
    ),
    'utf8',
  ),
);

// wrapMcpTool only stores the client for the execute closure, which these
// tests never invoke.
function fakeClient(): Client {
  return {} as never;
}

function wrap(inputSchema: Record<string, unknown>) {
  const wrapped = wrapMcpTool(
    {
      name: 'search_catalog',
      inputSchema,
    },
    {
      client: fakeClient(),
    },
  );
  if (!isClientTool(wrapped)) {
    throw new Error('expected a client tool');
  }
  return wrapped;
}

/** The arguments the tool's execute would receive, or `'rejected'`. */
function validated(inputSchema: Record<string, unknown>, args: unknown): unknown {
  const result = z.safeParse(wrap(inputSchema).function.inputSchema, args);
  return result.success ? result.data : 'rejected';
}

const meta = {
  'ucp-agent': {
    profile: 'https://example.com/profile.json',
  },
};

describe('MCP input schema with untyped combinator branches', () => {
  it.each([
    [
      'a product id',
      {
        id: 'gid://shopify/Product/1',
      },
    ],
    [
      'an inline image',
      {
        image: {
          content_type: 'image/png',
          data: 'AAAA',
        },
      },
    ],
  ])("accepts Shopify's search_catalog `like` given %s", (_label, like) => {
    const args = {
      meta,
      catalog: {
        like: [
          like,
        ],
      },
    };
    expect(validated(SHOPIFY_SEARCH_CATALOG, args)).toEqual(args);
  });

  it.each([
    [
      'a `like` item matching both branches',
      {
        like: [
          {
            id: 'gid://shopify/Product/1',
            image: {
              content_type: 'image/png',
              data: 'AAAA',
            },
          },
        ],
      },
    ],
    [
      'a `like` id that breaks the pattern',
      {
        like: [
          {
            id: 'not-a-gid',
          },
        ],
      },
    ],
    [
      'a catalog with none of query, like or filters',
      {},
    ],
    [
      'a blank query',
      {
        query: '  ',
      },
    ],
  ])("rejects Shopify's search_catalog given %s", (_label, catalog) => {
    expect(
      validated(SHOPIFY_SEARCH_CATALOG, {
        meta,
        catalog,
      }),
    ).toBe('rejected');
  });

  it('keeps sibling and unknown keys when a branch only names a required key', () => {
    const args = {
      meta,
      catalog: {
        query: 'shoes',
        context: {
          address_country: 'US',
        },
        not_in_the_schema: [
          1,
        ],
      },
    };
    expect(validated(SHOPIFY_SEARCH_CATALOG, args)).toMatchObject(args);
  });

  it("still sends the model the server's schema as written", () => {
    const asWritten = structuredClone(SHOPIFY_SEARCH_CATALOG);
    const [emitted] = convertToolsToAPIFormat([
      wrap(SHOPIFY_SEARCH_CATALOG),
    ]);
    expect(
      emitted !== undefined && 'parameters' in emitted ? emitted.parameters : undefined,
    ).toEqual(asWritten);
  });

  // The enclosing schema does not pin these values to an object, so a branch
  // with object keywords must keep accepting the non-object values.
  it.each([
    [
      'a nullable value',
      {
        type: [
          'object',
          'null',
        ],
      },
      null,
    ],
    [
      'a value with no type',
      {},
      'a string',
    ],
  ])('does not narrow %s to an object', (_label, enclosing, value) => {
    const inputSchema = {
      type: 'object',
      properties: {
        target: {
          ...enclosing,
          anyOf: [
            {
              required: [
                'id',
              ],
              properties: {
                id: {
                  type: 'string',
                },
              },
            },
          ],
        },
      },
    };
    const args = {
      target: value,
    };
    expect(validated(inputSchema, args)).toEqual(args);
  });

  it('applies to a definition reached through $ref', () => {
    const inputSchema = {
      type: 'object',
      properties: {
        target: {
          $ref: '#/$defs/Target',
        },
      },
      $defs: {
        Target: {
          type: 'object',
          oneOf: [
            {
              required: [
                'id',
              ],
              properties: {
                id: {
                  type: 'string',
                },
              },
              additionalProperties: false,
            },
            {
              required: [
                'url',
              ],
              properties: {
                url: {
                  type: 'string',
                },
              },
              additionalProperties: false,
            },
          ],
        },
      },
    };
    const args = {
      target: {
        url: 'https://example.com',
      },
    };
    expect(validated(inputSchema, args)).toEqual(args);
    expect(
      validated(inputSchema, {
        target: {},
      }),
    ).toBe('rejected');
  });
});

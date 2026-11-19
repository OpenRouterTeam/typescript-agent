import { describe, expect, it } from 'vitest';
import { sameToolDefs } from '../../../src/mcp/tool-defs-equal.js';
import type { McpToolDef } from '../../../src/mcp/tool-wrapper.js';

function def(overrides: Partial<McpToolDef> = {}): McpToolDef {
  return {
    name: 'search',
    description: 'Search things',
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
        },
      },
      required: [
        'q',
      ],
    },
    ...overrides,
  };
}

describe('sameToolDefs', () => {
  it('treats two separately built identical listings as the same', () => {
    expect(
      sameToolDefs(
        [
          def(),
        ],
        [
          def(),
        ],
      ),
    ).toBe(true);
  });

  it('ignores the order of object keys', () => {
    const reordered: McpToolDef = {
      inputSchema: {
        required: [
          'q',
        ],
        properties: {
          q: {
            type: 'string',
          },
        },
        type: 'object',
      },
      description: 'Search things',
      name: 'search',
    };

    expect(
      sameToolDefs(
        [
          def(),
        ],
        [
          reordered,
        ],
      ),
    ).toBe(true);
  });

  it.each([
    [
      'a different description',
      def({
        description: 'Search other things',
      }),
    ],
    [
      'a nested schema change',
      def({
        inputSchema: {
          type: 'object',
          properties: {
            q: {
              type: 'number',
            },
          },
          required: [
            'q',
          ],
        },
      }),
    ],
    [
      'an added output schema',
      def({
        outputSchema: {
          type: 'object',
        },
      }),
    ],
    [
      'a changed loop key',
      def({
        loopKey: false,
      }),
    ],
  ])('sees %s as a change', (_label, changed) => {
    expect(
      sameToolDefs(
        [
          def(),
        ],
        [
          changed,
        ],
      ),
    ).toBe(false);
  });

  it('sees a field this module has never heard of', () => {
    // The definitions are compared whole, so a field added to the type later
    // (MCP tool annotations, say) is covered without being listed here.
    const withExtra: McpToolDef = Object.assign(def(), {
      annotations: {
        readOnlyHint: true,
      },
    });
    const withOtherExtra: McpToolDef = Object.assign(def(), {
      annotations: {
        readOnlyHint: false,
      },
    });

    expect(
      sameToolDefs(
        [
          def(),
        ],
        [
          withExtra,
        ],
      ),
    ).toBe(false);
    expect(
      sameToolDefs(
        [
          withExtra,
        ],
        [
          withOtherExtra,
        ],
      ),
    ).toBe(false);
    expect(
      sameToolDefs(
        [
          withExtra,
        ],
        [
          Object.assign(def(), {
            annotations: {
              readOnlyHint: true,
            },
          }),
        ],
      ),
    ).toBe(true);
  });

  it('treats a reordered, added or removed tool as a change', () => {
    const other = def({
      name: 'fetch',
    });

    expect(
      sameToolDefs(
        [
          def(),
          other,
        ],
        [
          other,
          def(),
        ],
      ),
    ).toBe(false);
    expect(
      sameToolDefs(
        [
          def(),
        ],
        [
          def(),
          other,
        ],
      ),
    ).toBe(false);
    expect(sameToolDefs([], [])).toBe(true);
  });
});

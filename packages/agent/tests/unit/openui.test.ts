import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import type { UiExpr } from '../../src/lib/openui/document.js';
import { OPENUI_LANG_DIALECT, serializeExpr } from '../../src/lib/openui/document.js';
import { fragment, uiBuiltin, uiRef, uiState } from '../../src/lib/openui/fragment.js';
import { componentProps, createLibrary, defineComponent } from '../../src/lib/openui/library.js';
import { openui } from '../../src/lib/openui/plugin.js';

const library = createLibrary([
  defineComponent({
    name: 'Card',
    description: 'Container with a title',
    props: z.object({
      title: z.string(),
      children: z.array(z.unknown()).optional(),
    }),
  }),
  defineComponent({
    name: 'Text',
    props: z.object({
      value: z.string(),
    }),
  }),
  defineComponent({
    name: 'Divider',
  }),
]);

describe('serializeExpr', () => {
  it('serializes literals with JSON string quoting', () => {
    expect(
      serializeExpr({
        kind: 'literal',
        value: 'a "quoted" string',
      }),
    ).toBe('"a \\"quoted\\" string"');
    expect(
      serializeExpr({
        kind: 'literal',
        value: 42,
      }),
    ).toBe('42');
    expect(
      serializeExpr({
        kind: 'literal',
        value: true,
      }),
    ).toBe('true');
    expect(
      serializeExpr({
        kind: 'literal',
        value: null,
      }),
    ).toBe('null');
  });

  /*
   * Keys arrive from arbitrary tool-authored objects via `toExpr`, so a key
   * with spaces, quotes, punctuation, or a leading digit would emit source the
   * parser rejects. The grammar accepts a quoted key, so quoting round-trips.
   */
  it('quotes object keys that are not bare identifiers', () => {
    expect(
      serializeExpr({
        kind: 'object',
        entries: [
          {
            key: 'ok_key1',
            value: {
              kind: 'literal',
              value: 1,
            },
          },
          {
            key: 'has space',
            value: {
              kind: 'literal',
              value: 2,
            },
          },
          {
            key: '2leading',
            value: {
              kind: 'literal',
              value: 3,
            },
          },
          {
            key: 'has"quote',
            value: {
              kind: 'literal',
              value: 4,
            },
          },
          {
            key: '',
            value: {
              kind: 'literal',
              value: 5,
            },
          },
        ],
      }),
    ).toBe('{ok_key1: 1, "has space": 2, "2leading": 3, "has\\"quote": 4, "": 5}');
  });

  /*
   * `String(NaN)`/`String(Infinity)` emit bare identifiers, which parse back as
   * refs to undefined names rather than numbers. JSON has the same hole and
   * resolves it as null.
   */
  it('serializes non-finite numbers as null rather than bare identifiers', () => {
    expect(
      serializeExpr({
        kind: 'literal',
        value: Number.NaN,
      }),
    ).toBe('null');
    expect(
      serializeExpr({
        kind: 'literal',
        value: Number.POSITIVE_INFINITY,
      }),
    ).toBe('null');
    expect(
      serializeExpr({
        kind: 'literal',
        value: Number.NEGATIVE_INFINITY,
      }),
    ).toBe('null');
    /* Finite numbers, including negative zero, are untouched. */
    expect(
      serializeExpr({
        kind: 'literal',
        value: -1.5,
      }),
    ).toBe('-1.5');
  });

  it('serializes refs, state refs, and member access', () => {
    expect(
      serializeExpr({
        kind: 'ref',
        name: 'chart',
      }),
    ).toBe('chart');
    expect(
      serializeExpr({
        kind: 'state-ref',
        name: 'tab',
      }),
    ).toBe('$tab');
    expect(
      serializeExpr({
        kind: 'member',
        base: {
          kind: 'ref',
          name: 'data',
        },
        path: [
          'rows',
          'title',
        ],
      }),
    ).toBe('data.rows.title');
  });

  it('serializes arrays, objects, and calls (builtin vs component)', () => {
    const expr: UiExpr = {
      kind: 'call',
      fn: 'Action',
      builtin: false,
      args: [
        {
          kind: 'array',
          items: [
            {
              kind: 'call',
              fn: 'Run',
              builtin: true,
              args: [
                {
                  kind: 'ref',
                  name: 'save',
                },
              ],
            },
          ],
        },
        {
          kind: 'object',
          entries: [
            {
              key: 'once',
              value: {
                kind: 'literal',
                value: true,
              },
            },
          ],
        },
      ],
    };
    expect(serializeExpr(expr)).toBe('Action([@Run(save)], {once: true})');
  });
});

describe('createLibrary / componentProps', () => {
  it('preserves component order and rejects duplicates', () => {
    expect(library.componentNames).toEqual([
      'Card',
      'Text',
      'Divider',
    ]);
    expect(library.dialect).toBe(OPENUI_LANG_DIALECT);
    expect(() =>
      createLibrary([
        defineComponent({
          name: 'A',
        }),
        defineComponent({
          name: 'A',
        }),
      ]),
    ).toThrow(/duplicate component name 'A'/);
  });

  it('rejects component names that are not identifiers', () => {
    expect(() =>
      defineComponent({
        name: 'Card); injected = Text("pwned")',
      }),
    ).toThrow(/component name .* must match/);
    expect(() =>
      createLibrary([
        {
          name: 'Card-name',
        },
      ]),
    ).toThrow(/component name .* must match/);
  });

  it('reports prop signatures in declaration order with optionality', () => {
    const card = library.components.get('Card');
    expect(card).toBeDefined();
    const props = componentProps(card!);
    expect(props.map((p) => p.name)).toEqual([
      'title',
      'children',
    ]);
    expect(props.map((p) => p.optional)).toEqual([
      false,
      true,
    ]);
  });

  it('supports a custom dialect', () => {
    const custom = createLibrary(
      [
        defineComponent({
          name: 'X',
        }),
      ],
      {
        dialect: 'openui-lang/0.6',
      },
    );
    expect(custom.dialect).toBe('openui-lang/0.6');
  });
});

describe('fragment builder', () => {
  const ui = fragment(library);

  it('builds a serialized fragment rooted at `root`', () => {
    const node = ui.Card('Usage', [
      ui.Text('hello'),
    ]);
    expect(node.dialect).toBe(OPENUI_LANG_DIALECT);
    expect(node.source).toBe('root = Card("Usage", [Text("hello")])');
  });

  it('composes refs, state, and builtins', () => {
    const node = ui.Card('Tabs', [
      uiState('tab'),
      uiBuiltin('Run', uiRef('load')),
    ]);
    expect(node.source).toBe('root = Card("Tabs", [$tab, @Run(load)])');
    expect(ui.Action([]).source).toBe('root = Action([])');
    expect(ui.Query('weather', {}).source).toBe('root = Query("weather", {})');
  });

  it('accepts plain objects and arrays as args', () => {
    const node = ui.Text('ok');
    const wrapped = ui.Card('W', [
      node,
      {
        nested: [
          1,
          true,
          null,
        ],
      } as never,
    ]);
    expect(wrapped.source).toBe('root = Card("W", [Text("ok"), {nested: [1, true, null]}])');
  });

  it('serializes undefined arguments as null and omits undefined object properties', () => {
    expect(ui.Card(undefined).source).toBe('root = Card(null)');
    expect(
      ui.Query('weather', {
        city: undefined,
        units: 'metric',
      }).source,
    ).toBe('root = Query("weather", {units: "metric"})');
  });

  it('validates literal props at construction time', () => {
    expect(() => ui.Text(42)).toThrow(/Text\(\) prop 'value' rejects 42/);
  });

  it('rejects arity overflow', () => {
    expect(() => ui.Divider('extra')).toThrow(/Divider\(\) takes at most 0 argument\(s\)/);
  });

  it('skips validation for dynamic args (refs resolve at render time)', () => {
    expect(() => ui.Text(uiRef('someRef'))).not.toThrow();
    expect(ui.Text(uiState('value')).source).toBe('root = Text($value)');
  });
});

describe('openui() plugin helper', () => {
  it('produces the wire-shaped plugin preference with JSON Schema props', () => {
    const plugin = openui(library);
    expect(plugin.id).toBe('openui');
    expect(plugin.dialect).toBe(OPENUI_LANG_DIALECT);
    expect(plugin.library.map((c) => c.name)).toEqual([
      'Card',
      'Text',
      'Divider',
    ]);

    const card = plugin.library[0];
    expect(card?.description).toBe('Container with a title');
    expect(card?.props).toMatchObject({
      type: 'object',
      required: [
        'title',
      ],
    });
    // Property declaration order is normative for positional-arg mapping.
    expect(
      Object.keys(
        (
          card?.props as {
            properties: object;
          }
        ).properties,
      ),
    ).toEqual([
      'title',
      'children',
    ]);

    const defaults = openui(
      createLibrary([
        defineComponent({
          name: 'Defaults',
          props: z.object({
            label: z.string().default('hello'),
          }),
        }),
      ]),
    );
    expect(defaults.library[0]?.props).toMatchObject({
      type: 'object',
    });
    expect(defaults.library[0]?.props).not.toHaveProperty('required');

    const divider = plugin.library[2];
    expect(divider?.props).toBeUndefined();
    expect(divider?.description).toBeUndefined();
  });
});

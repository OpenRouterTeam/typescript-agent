import type { ConversationState, CorrelatedToolEventUnion } from '@openrouter/agent';
import { serverTool, tool } from '@openrouter/agent';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type {
  InferAllIds,
  InferConditionalIds,
  InferDisabledIds,
  InferEnabledIds,
  InferToolSet,
} from '../../src/index.js';
import { createToolSet } from '../../src/index.js';

const makeTool = (name: string) =>
  tool({
    name,
    description: `${name} tool`,
    inputSchema: z.object({}),
    execute: async () => ({
      name,
    }),
  });

const a = makeTool('a');
const b = makeTool('b');
const c = makeTool('c');

const minimalState = (partial?: Partial<ConversationState>): ConversationState => ({
  id: 'conv_test',
  messages: [],
  status: 'complete',
  createdAt: 0,
  updatedAt: 0,
  ...partial,
});

describe('createToolSet', () => {
  it('preserves tool order via the .tools getter', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    });
    expect(ts.tools.map((t) => ('function' in t ? t.function.name : t.id))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expectTypeOf(ts.tools).toEqualTypeOf<
      readonly [
        typeof a,
        typeof b,
        typeof c,
      ]
    >();
  });

  it('throws on duplicate tool names at construction', () => {
    const dup = makeTool('a');
    expect(() =>
      createToolSet({
        tools: [
          a,
          dup,
        ] as const,
      }),
    ).toThrow(/Duplicate tool ID: "a"/);
  });

  it('constructs an empty set without tools', () => {
    const ts = createToolSet({
      tools: [] as const,
    });
    expect(ts.tools).toEqual([]);
    expect(ts.resolve()).toMatchObject({
      tools: [],
      activeTools: [],
      enabled: [],
      disabled: [],
      statusByTool: {},
    });
  });

  it('defaults all tools to active when no directives are set', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    });
    const { tools, activeTools, enabled, disabled, statusByTool } = ts.resolve();
    expect(tools).toEqual([
      a,
      b,
    ]);
    expect(activeTools).toEqual([
      'a',
      'b',
    ]);
    expect(enabled).toEqual([
      'a',
      'b',
    ]);
    expect(disabled).toEqual([]);
    expect(statusByTool).toEqual({
      a: {
        enabled: true,
        reason: 'default',
      },
      b: {
        enabled: true,
        reason: 'default',
      },
    });
  });
});

describe('activate / deactivate', () => {
  it('deactivates a single tool by name', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    }).deactivate('b');
    expect(ts.resolve().activeTools).toEqual([
      'a',
      'c',
    ]);
    expect(ts.resolve().disabled).toEqual([
      'b',
    ]);
  });

  it('activates/deactivates arrays of names', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    })
      .deactivate([
        'a',
        'b',
      ])
      .activate([
        'b',
      ]);
    expect(ts.resolve().activeTools).toEqual([
      'b',
      'c',
    ]);
  });

  it('throws on unknown names', () => {
    const ts = createToolSet({
      tools: [
        a,
      ] as const,
    });
    expect(() => ts.activate('missing' as 'a')).toThrow(/Unknown tool: "missing"/);
    expect(() =>
      ts.deactivate([
        'a',
        'missing' as 'a',
      ]),
    ).toThrow(/Unknown tool: "missing"/);
  });
});

describe('activateWhen', () => {
  it('defaults to inactive and flips based on predicate', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    }).activateWhen('a', ({ context }) => context?.['enabled'] === true);
    expect(ts.resolve().activeTools).toEqual([
      'b',
    ]);
    expect(
      ts.resolve({
        context: {
          enabled: true,
        },
      }).activeTools,
    ).toEqual([
      'a',
      'b',
    ]);
  });

  it('accepts a predicate map', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    }).activateWhen({
      a: () => true,
      b: () => false,
    });
    expect(ts.resolve().activeTools).toEqual([
      'a',
    ]);
  });

  it('validates every name in the map before applying', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    });
    expect(() =>
      ts.activateWhen({
        a: () => true,
        // @ts-expect-error unknown id
        nope: () => true,
      }),
    ).toThrow(/Unknown tool: "nope"/);
    // original untouched
    expect(ts.resolve().activeTools).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('deactivateWhen', () => {
  it('defaults to active and flips inactive when predicate is true', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    }).deactivateWhen('a', () => true);
    expect(ts.resolve().activeTools).toEqual([
      'b',
    ]);
  });

  it('accepts a predicate map', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    }).deactivateWhen({
      a: () => true,
      b: () => false,
    });
    expect(ts.resolve().activeTools).toEqual([
      'b',
    ]);
  });
});

describe('last-call-wins semantics', () => {
  it('resolves to the most recent directive per tool', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    })
      .activate('a')
      .deactivateWhen('a', () => true);
    expect(ts.resolve().activeTools).toEqual([
      'b',
    ]);

    const ts2 = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    })
      .deactivateWhen('a', () => true)
      .activate('a');
    expect(ts2.resolve().activeTools).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('immutability vs mutability', () => {
  it('is immutable by default — mutators return a new instance', () => {
    const base = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    });
    const next = base.deactivate('a');
    expect(next).not.toBe(base);
    expect(base.resolve().activeTools).toEqual([
      'a',
      'b',
    ]);
    expect(next.resolve().activeTools).toEqual([
      'b',
    ]);
  });

  it('mutates in place when mutable: true', () => {
    const base = createToolSet({
      tools: [
        a,
        b,
      ] as const,
      mutable: true,
    });
    const next = base.deactivate('a');
    expect(next).toBe(base);
    expect(base.resolve().activeTools).toEqual([
      'b',
    ]);
  });
});

describe('clone', () => {
  it('copies state and can flip mode', () => {
    const immutable = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    }).deactivate('a');
    const mutableCopy = immutable.clone({
      mutable: true,
    });
    mutableCopy.activate('a');
    expect(mutableCopy.resolve().activeTools).toEqual([
      'a',
      'b',
    ]);
    // original untouched
    expect(immutable.resolve().activeTools).toEqual([
      'b',
    ]);
  });

  it('inherits mode when not overridden', () => {
    const mutable = createToolSet({
      tools: [
        a,
      ] as const,
      mutable: true,
    });
    const clone = mutable.clone();
    const after = clone.deactivate('a');
    expect(after).toBe(clone);
  });
});

describe('resolve / inferTools input shapes', () => {
  it('handles undefined and empty input', () => {
    const ts = createToolSet({
      tools: [
        a,
      ] as const,
    }).activateWhen('a', ({ state, context }) => state === undefined && context === undefined);
    expect(ts.resolve().activeTools).toEqual([
      'a',
    ]);
    expect(ts.resolve({}).activeTools).toEqual([
      'a',
    ]);
  });

  it('passes typed state and context to the predicate', () => {
    const spy = vi.fn(() => true);
    const ts = createToolSet({
      tools: [
        a,
      ] as const,
    }).activateWhen('a', spy);
    const state = minimalState({
      messages: [
        {
          role: 'user',
          content: 'hi',
        },
      ],
    });
    ts.resolve({
      state,
      context: {
        foo: 'bar',
      },
    });
    expect(spy).toHaveBeenCalledWith({
      state,
      context: {
        foo: 'bar',
      },
    });
  });

  it('keeps inferTools as a back-compat alias of resolve', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    }).deactivate('a');
    const viaResolve = ts.resolve();
    const viaInfer = ts.inferTools();
    expect(viaInfer.tools).toEqual(viaResolve.tools);
    expect(viaInfer.activeTools).toEqual(viaResolve.activeTools);
    expect(viaInfer.enabled).toEqual(viaResolve.enabled);
    expect(viaInfer.disabled).toEqual(viaResolve.disabled);
    expect(viaInfer.statusByTool).toEqual(viaResolve.statusByTool);
  });
});

describe('exhaustive statusByTool snapshot', () => {
  it('includes every ID with reason/directive/predicate metadata', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    })
      .deactivate('b')
      .activateWhen('c', () => true);

    const { statusByTool, enabled, disabled } = ts.resolve();
    expect(Object.keys(statusByTool).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(statusByTool.a).toEqual({
      enabled: true,
      reason: 'default',
    });
    expect(statusByTool.b).toEqual({
      enabled: false,
      reason: 'deactivate',
      directive: 'deactivate',
    });
    expect(statusByTool.c).toEqual({
      enabled: true,
      reason: 'activateWhen',
      directive: 'activateWhen',
      predicate: true,
    });
    expect(enabled).toEqual([
      'a',
      'c',
    ]);
    expect(disabled).toEqual([
      'b',
    ]);
  });
});

describe('compile-time partition inference', () => {
  it('tracks static activate/deactivate transitions', () => {
    const base = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    });
    expectTypeOf<InferAllIds<typeof base>>().toEqualTypeOf<'a' | 'b' | 'c'>();
    expectTypeOf<InferEnabledIds<typeof base>>().toEqualTypeOf<'a' | 'b' | 'c'>();
    expectTypeOf<InferDisabledIds<typeof base>>().toEqualTypeOf<never>();
    expectTypeOf<InferConditionalIds<typeof base>>().toEqualTypeOf<never>();

    const afterDeactivate = base.deactivate('b');
    expectTypeOf<InferEnabledIds<typeof afterDeactivate>>().toEqualTypeOf<'a' | 'c'>();
    expectTypeOf<InferDisabledIds<typeof afterDeactivate>>().toEqualTypeOf<'b'>();
    expectTypeOf<InferConditionalIds<typeof afterDeactivate>>().toEqualTypeOf<never>();

    const afterActivate = afterDeactivate.activate('b');
    expectTypeOf<InferEnabledIds<typeof afterActivate>>().toEqualTypeOf<'a' | 'b' | 'c'>();
    expectTypeOf<InferDisabledIds<typeof afterActivate>>().toEqualTypeOf<never>();
  });

  it('moves IDs into conditional via activateWhen/deactivateWhen', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    })
      .deactivate('b')
      .activateWhen('a', () => true)
      .deactivateWhen('c', () => false);

    expectTypeOf<InferEnabledIds<typeof ts>>().toEqualTypeOf<never>();
    expectTypeOf<InferDisabledIds<typeof ts>>().toEqualTypeOf<'b'>();
    expectTypeOf<InferConditionalIds<typeof ts>>().toEqualTypeOf<'a' | 'c'>();

    // Static-only resolve is exact; with conditional IDs, tools is the upper bound.
    const snapshot = ts.resolve();
    expectTypeOf(snapshot.enabled).toEqualTypeOf<readonly ('a' | 'c')[]>();
    expectTypeOf(snapshot.disabled).toEqualTypeOf<readonly 'b'[]>();
  });

  it('returns an exactly-typed active tool tuple for static partitions', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    }).deactivate('b');
    const { tools, activeTools } = ts.resolve();
    expectTypeOf(tools).toEqualTypeOf<
      readonly [
        typeof a,
        typeof c,
      ]
    >();
    expectTypeOf(activeTools).toEqualTypeOf<readonly ('a' | 'c')[]>();
    expect(tools).toEqual([
      a,
      c,
    ]);
  });
});

describe('server tools', () => {
  const webSearch = serverTool({
    type: 'web_search_2025_08_26',
  });
  const datetime = serverTool({
    type: 'openrouter:datetime',
  });
  const publicSearch = serverTool(
    {
      type: 'web_search_2025_08_26',
    },
    {
      id: 'server:public_search',
    },
  );

  it('assigns default server IDs from config.type', () => {
    expect(webSearch.id).toBe('server:web_search_2025_08_26');
    expect(datetime.id).toBe('server:openrouter:datetime');
    expectTypeOf(webSearch.id).toEqualTypeOf<'server:web_search_2025_08_26'>();
    expectTypeOf(publicSearch.id).toEqualTypeOf<'server:public_search'>();
  });

  it('preserves server tools in .tools in construction order', () => {
    const ts = createToolSet({
      tools: [
        a,
        webSearch,
        b,
        datetime,
      ] as const,
    });
    expect(ts.tools).toEqual([
      a,
      webSearch,
      b,
      datetime,
    ]);
    expectTypeOf<InferAllIds<typeof ts>>().toEqualTypeOf<
      'a' | 'b' | 'server:web_search_2025_08_26' | 'server:openrouter:datetime'
    >();
  });

  it('includes active server tools in tools/enabled/statusByTool but not activeTools', () => {
    const ts = createToolSet({
      tools: [
        a,
        webSearch,
        b,
      ] as const,
    }).deactivate('a');
    const { tools, activeTools, enabled, statusByTool } = ts.resolve();
    expect(tools).toEqual([
      webSearch,
      b,
    ]);
    expect(activeTools).toEqual([
      'b',
    ]);
    expect(enabled).toEqual([
      'server:web_search_2025_08_26',
      'b',
    ]);
    expect(statusByTool['server:web_search_2025_08_26']).toEqual({
      enabled: true,
      reason: 'default',
    });
  });

  it('can deactivate server tools by stable ID', () => {
    const ts = createToolSet({
      tools: [
        a,
        webSearch,
        b,
      ] as const,
    }).deactivate('server:web_search_2025_08_26');
    const { tools, enabled, disabled, statusByTool } = ts.resolve();
    expect(tools).toEqual([
      a,
      b,
    ]);
    expect(enabled).toEqual([
      'a',
      'b',
    ]);
    expect(disabled).toEqual([
      'server:web_search_2025_08_26',
    ]);
    expect(statusByTool['server:web_search_2025_08_26']).toEqual({
      enabled: false,
      reason: 'deactivate',
      directive: 'deactivate',
    });
  });

  it('supports override IDs and rejects duplicates', () => {
    const ts = createToolSet({
      tools: [
        a,
        publicSearch,
      ] as const,
    });
    expectTypeOf<InferAllIds<typeof ts>>().toEqualTypeOf<'a' | 'server:public_search'>();
    expect(ts.resolve().enabled).toEqual([
      'a',
      'server:public_search',
    ]);

    expect(() =>
      createToolSet({
        tools: [
          webSearch,
          serverTool({
            type: 'web_search_2025_08_26',
          }),
        ] as const,
      }),
    ).toThrow(/Duplicate tool ID: "server:web_search_2025_08_26"/);
  });

  it('rejects activate/deactivate attempts on unknown / raw type strings', () => {
    const ts = createToolSet({
      tools: [
        a,
        webSearch,
      ] as const,
    });
    expect(() => ts.activate('web_search_2025_08_26' as 'a')).toThrow(/Unknown tool/);
  });
});

describe('defineSituations / resolveSituation', () => {
  it('overlays static enabled/disabled and returns exact tuples', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    })
      .deactivate('c')
      .defineSituations({
        guest: {
          enabled: [
            'a',
          ],
          disabled: [
            'b',
            'c',
          ],
        },
        full: {
          enabled: [
            'a',
            'b',
            'c',
          ],
        },
      });

    const guest = ts.resolveSituation('guest');
    expect(guest.tools).toEqual([
      a,
    ]);
    expect(guest.activeTools).toEqual([
      'a',
    ]);
    expect(guest.enabled).toEqual([
      'a',
    ]);
    expect(guest.disabled).toEqual([
      'b',
      'c',
    ]);
    expect(guest.statusByTool).toEqual({
      a: {
        enabled: true,
        reason: 'situation',
        directive: 'activate',
      },
      b: {
        enabled: false,
        reason: 'situation',
        directive: 'deactivate',
      },
      c: {
        enabled: false,
        reason: 'situation',
        directive: 'deactivate',
      },
    });
    expectTypeOf(guest.tools).toEqualTypeOf<
      readonly [
        typeof a,
      ]
    >();

    const full = ts.resolveSituation('full');
    expect(full.tools).toEqual([
      a,
      b,
      c,
    ]);
    expectTypeOf(full.tools).toEqualTypeOf<
      readonly [
        typeof a,
        typeof b,
        typeof c,
      ]
    >();
  });

  it('supports conditional situation rules with runtime-exact status', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    }).defineSituations({
      authed: {
        enabled: [
          'a',
        ],
        disabled: [
          'b',
        ],
        conditional: {
          c: ({ context }) => context?.['admin'] === true,
        },
      },
    });

    const denied = ts.resolveSituation('authed', {
      context: {
        admin: false,
      },
    });
    expect(denied.tools).toEqual([
      a,
    ]);
    expect(denied.enabled).toEqual([
      'a',
    ]);
    expect(denied.disabled).toEqual([
      'b',
      'c',
    ]);
    expect(denied.statusByTool.c).toMatchObject({
      enabled: false,
      reason: 'situation',
      directive: 'activateWhen',
      predicate: true,
    });

    const allowed = ts.resolveSituation('authed', {
      context: {
        admin: true,
      },
    });
    expect(allowed.tools).toEqual([
      a,
      c,
    ]);
    expect(allowed.enabled).toEqual([
      'a',
      'c',
    ]);
  });

  it('validates unknown / duplicate / conflicting IDs in a situation', () => {
    const base = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    });

    expect(() =>
      base.defineSituations({
        bad: {
          enabled: [
            // @ts-expect-error unknown id
            'nope',
          ],
        },
      }),
    ).toThrow(/Unknown tool: "nope"/);

    expect(() =>
      base.defineSituations({
        bad: {
          enabled: [
            'a',
          ],
          disabled: [
            'a',
          ],
        },
      }),
    ).toThrow(/lists tool "a" more than once/);

    expect(() =>
      base.defineSituations({
        bad: {
          enabled: [
            'a',
          ],
          conditional: {
            a: () => true,
          },
        },
      }),
    ).toThrow(/lists tool "a" more than once/);
  });

  it('throws on unknown situation names at resolve time', () => {
    const ts = createToolSet({
      tools: [
        a,
      ] as const,
    }).defineSituations({
      guest: {
        enabled: [
          'a',
        ],
      },
    });
    expect(() => ts.resolveSituation('missing' as 'guest')).toThrow(/Unknown situation: "missing"/);
  });

  it('leaves unmentioned IDs on the base partition', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    })
      .deactivate('c')
      .defineSituations({
        onlyB: {
          disabled: [
            'b',
          ],
        },
      });

    const snapshot = ts.resolveSituation('onlyB');
    // a stays default-enabled, b disabled by situation, c disabled by base
    expect(snapshot.enabled).toEqual([
      'a',
    ]);
    expect(snapshot.disabled).toEqual([
      'b',
      'c',
    ]);
  });
});

describe('TShared generic', () => {
  type AppContext = {
    isAuthenticated: boolean;
    userId: string;
  };

  it('types predicate context when TShared is supplied to createToolSet', () => {
    const allTools = [
      a,
    ] as const;
    const ts = createToolSet<typeof allTools, AppContext>({
      tools: allTools,
    }).activateWhen('a', ({ context }) => {
      if (!context) {
        return false;
      }
      expectTypeOf(context).toEqualTypeOf<AppContext>();
      return context.isAuthenticated;
    });

    expect(
      ts.resolve({
        context: {
          isAuthenticated: true,
          userId: 'u1',
        },
      }).activeTools,
    ).toEqual([
      'a',
    ]);
    expect(
      ts.resolve({
        context: {
          isAuthenticated: false,
          userId: 'u1',
        },
      }).activeTools,
    ).toEqual([]);
  });

  it('defaults to Record<string, unknown> when TShared is omitted', () => {
    const ts = createToolSet({
      tools: [
        a,
      ] as const,
    }).activateWhen('a', ({ context }) => {
      if (!context) {
        return false;
      }
      expectTypeOf(context).toEqualTypeOf<Record<string, unknown>>();
      return context['enabled'] === true;
    });
    expect(
      ts.resolve({
        context: {
          enabled: true,
        },
      }).activeTools,
    ).toEqual([
      'a',
    ]);
  });
});

describe('InferToolSet / event narrowing', () => {
  it('aliases CorrelatedToolEventUnion from @openrouter/agent', () => {
    const weather = tool({
      name: 'weather',
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.object({
        temp: z.number(),
      }),
      execute: async () => ({
        temp: 72,
      }),
    });
    const tools = [
      weather,
    ] as const;

    type FromHelper = InferToolSet<typeof tools>;
    type FromCore = CorrelatedToolEventUnion<typeof tools>;
    expectTypeOf<FromHelper>().toEqualTypeOf<FromCore>();

    const ts = createToolSet({
      tools,
    });
    const resolved = ts.resolve();
    // Spreading into callModel keeps the concrete tools tuple
    expectTypeOf(resolved.tools).toEqualTypeOf<
      readonly [
        typeof weather,
      ]
    >();
  });
});

describe('callModel-oriented spread shape', () => {
  it('produces tools + activeTools suitable for callModel spread', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
        c,
      ] as const,
    }).deactivate('b');
    const snapshot = ts.resolve();

    // Structural match for BaseCallModelInput's tools/activeTools fields
    const forCallModel: {
      tools: readonly [
        typeof a,
        typeof c,
      ];
      activeTools: readonly ('a' | 'c')[];
    } = {
      tools: snapshot.tools,
      activeTools: snapshot.activeTools,
    };
    expect(forCallModel.tools).toEqual([
      a,
      c,
    ]);
    expect(forCallModel.activeTools).toEqual([
      'a',
      'c',
    ]);
  });
});

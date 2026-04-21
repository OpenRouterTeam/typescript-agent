import type { ConversationState } from '@openrouter/agent';
import { serverTool, tool } from '@openrouter/agent';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { createToolSet } from '../../src/tool-set.js';

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
    expect(ts.tools.map((t) => t.function.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
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
    ).toThrow(/Duplicate tool name: "a"/);
  });

  it('constructs an empty set without tools', () => {
    const ts = createToolSet({
      tools: [] as const,
    });
    expect(ts.tools).toEqual([]);
    expect(ts.inferTools()).toEqual({
      tools: [],
      activeTools: [],
    });
  });

  it('defaults all tools to active when no directives are set', () => {
    const ts = createToolSet({
      tools: [
        a,
        b,
      ] as const,
    });
    const { tools, activeTools } = ts.inferTools();
    expect(tools).toEqual([
      a,
      b,
    ]);
    expect(activeTools).toEqual([
      'a',
      'b',
    ]);
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
    expect(ts.inferTools().activeTools).toEqual([
      'a',
      'c',
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
    expect(ts.inferTools().activeTools).toEqual([
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
    expect(() => ts.activate('missing')).toThrow(/Unknown tool: "missing"/);
    expect(() =>
      ts.deactivate([
        'a',
        'missing',
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
    expect(ts.inferTools().activeTools).toEqual([
      'b',
    ]);
    expect(
      ts.inferTools({
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
    expect(ts.inferTools().activeTools).toEqual([
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
        nope: () => true,
      }),
    ).toThrow(/Unknown tool: "nope"/);
    // original untouched
    expect(ts.inferTools().activeTools).toEqual([
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
    expect(ts.inferTools().activeTools).toEqual([
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
    expect(ts.inferTools().activeTools).toEqual([
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
    expect(ts.inferTools().activeTools).toEqual([
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
    expect(ts2.inferTools().activeTools).toEqual([
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
    expect(base.inferTools().activeTools).toEqual([
      'a',
      'b',
    ]);
    expect(next.inferTools().activeTools).toEqual([
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
    expect(base.inferTools().activeTools).toEqual([
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
    expect(mutableCopy.inferTools().activeTools).toEqual([
      'a',
      'b',
    ]);
    // original untouched
    expect(immutable.inferTools().activeTools).toEqual([
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

describe('inferTools input shapes', () => {
  it('handles undefined and empty input', () => {
    const ts = createToolSet({
      tools: [
        a,
      ] as const,
    }).activateWhen('a', ({ state, context }) => state === undefined && context === undefined);
    expect(ts.inferTools().activeTools).toEqual([
      'a',
    ]);
    expect(ts.inferTools({}).activeTools).toEqual([
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
    ts.inferTools({
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
});

describe('server tools', () => {
  const webSearch = serverTool({
    type: 'web_search_2025_08_26',
  });
  const datetime = serverTool({
    type: 'openrouter:datetime',
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
  });

  it('includes server tools in inferTools output as always-active', () => {
    const ts = createToolSet({
      tools: [
        a,
        webSearch,
        b,
      ] as const,
    }).deactivate('a');
    const { tools, activeTools } = ts.inferTools();
    expect(tools).toEqual([
      webSearch,
      b,
    ]);
    // server tools have no `function.name` and are never present in activeTools
    expect(activeTools).toEqual([
      'b',
    ]);
  });

  it('keeps server tools even when all client tools are deactivated', () => {
    const ts = createToolSet({
      tools: [
        a,
        webSearch,
        b,
      ] as const,
    })
      .deactivate('a')
      .deactivate('b');
    const { tools, activeTools } = ts.inferTools();
    expect(tools).toEqual([
      webSearch,
    ]);
    expect(activeTools).toEqual([]);
  });

  it('rejects activate/deactivate attempts on server tools (they have no name)', () => {
    const ts = createToolSet({
      tools: [
        a,
        webSearch,
      ] as const,
    });
    expect(() => ts.activate('web_search_2025_08_26')).toThrow(/Unknown tool/);
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
      // Inside the predicate, context is typed as AppContext | undefined.
      if (!context) {
        return false;
      }
      expectTypeOf(context).toEqualTypeOf<AppContext>();
      return context.isAuthenticated;
    });

    expect(
      ts.inferTools({
        context: {
          isAuthenticated: true,
          userId: 'u1',
        },
      }).activeTools,
    ).toEqual([
      'a',
    ]);
    expect(
      ts.inferTools({
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
      // Context defaults to Record<string, unknown> | undefined; values are `unknown`.
      if (!context) {
        return false;
      }
      expectTypeOf(context).toEqualTypeOf<Record<string, unknown>>();
      return context['enabled'] === true;
    });
    expect(
      ts.inferTools({
        context: {
          enabled: true,
        },
      }).activeTools,
    ).toEqual([
      'a',
    ]);
  });
});

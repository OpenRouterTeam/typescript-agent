import { describe, expect, it } from 'vitest';
import * as z4 from 'zod/v4';
import { buildToolExecuteContext, ToolContextStore } from '../../src/lib/tool-context.js';
import type { TurnContext } from '../../src/lib/tool-types.js';
import { SHARED_CONTEXT_KEY } from '../../src/lib/tool-types.js';

//#region Shared context via buildToolExecuteContext

describe('shared context', () => {
  const turnContext: TurnContext = {
    numberOfTurns: 1,
  };

  it('should return empty frozen object when store has no shared context', () => {
    const store = new ToolContextStore({
      my_tool: {
        key: 'value',
      },
    });

    const ctx = buildToolExecuteContext<'my_tool', Record<string, unknown>>(
      turnContext,
      store,
      'my_tool',
      undefined,
    );

    expect(ctx.shared).toEqual({});
    expect(Object.isFrozen(ctx.shared)).toBe(true);
  });

  it('should return empty frozen object when store is undefined', () => {
    const ctx = buildToolExecuteContext<'my_tool', Record<string, unknown>>(
      turnContext,
      undefined,
      'my_tool',
      undefined,
    );

    expect(ctx.shared).toEqual({});
    expect(Object.isFrozen(ctx.shared)).toBe(true);
  });

  it('should read shared context seeded in the store', () => {
    const store = new ToolContextStore({
      [SHARED_CONTEXT_KEY]: {
        sessionId: 'abc-123',
        userId: 'user-1',
      },
    });

    const ctx = buildToolExecuteContext<'my_tool', Record<string, unknown>>(
      turnContext,
      store,
      'my_tool',
      undefined,
    );

    expect(ctx.shared).toEqual({
      sessionId: 'abc-123',
      userId: 'user-1',
    });
  });

  it('should write shared context via setSharedContext with schema', () => {
    const store = new ToolContextStore({});
    const sharedSchema = z4.object({
      key: z4.string().optional(),
    });

    const ctx = buildToolExecuteContext<
      'my_tool',
      Record<string, unknown>,
      {
        key?: string;
      }
    >(turnContext, store, 'my_tool', undefined, sharedSchema);

    ctx.setSharedContext({
      key: 'value',
    });

    expect(ctx.shared).toEqual({
      key: 'value',
    });
    expect(store.getToolContext(SHARED_CONTEXT_KEY)).toEqual({
      key: 'value',
    });
  });

  it('should merge partial values into shared context', () => {
    const store = new ToolContextStore({
      [SHARED_CONTEXT_KEY]: {
        existing: 'data',
      },
    });
    const sharedSchema = z4.object({
      existing: z4.string().optional(),
      newKey: z4.string().optional(),
    });

    const ctx = buildToolExecuteContext<
      'my_tool',
      Record<string, unknown>,
      {
        existing?: string;
        newKey?: string;
      }
    >(turnContext, store, 'my_tool', undefined, sharedSchema);

    ctx.setSharedContext({
      newKey: 'newValue',
    });

    expect(ctx.shared).toEqual({
      existing: 'data',
      newKey: 'newValue',
    });
  });

  it('should be readable across different tools via the same store', () => {
    const store = new ToolContextStore({
      tool_a: {
        a: 1,
      },
      tool_b: {
        b: 2,
      },
    });
    const schemaA = z4.object({
      a: z4.number(),
    });
    const schemaB = z4.object({
      b: z4.number(),
    });
    const sharedSchema = z4.object({
      fromA: z4.string().optional(),
      fromB: z4.string().optional(),
    });

    const ctxA = buildToolExecuteContext<
      'tool_a',
      {
        a: number;
      },
      {
        fromA?: string;
        fromB?: string;
      }
    >(turnContext, store, 'tool_a', schemaA, sharedSchema);
    const ctxB = buildToolExecuteContext<
      'tool_b',
      {
        b: number;
      },
      {
        fromA?: string;
        fromB?: string;
      }
    >(turnContext, store, 'tool_b', schemaB, sharedSchema);

    // Tool A writes shared context
    ctxA.setSharedContext({
      fromA: 'hello',
    });

    // Tool B can read it
    expect(ctxB.shared).toEqual({
      fromA: 'hello',
    });

    // Tool B adds more
    ctxB.setSharedContext({
      fromB: 'world',
    });

    // Both tools see merged result
    expect(ctxA.shared).toEqual({
      fromA: 'hello',
      fromB: 'world',
    });
    expect(ctxB.shared).toEqual({
      fromA: 'hello',
      fromB: 'world',
    });
  });

  it('should be a no-op for setSharedContext when store is undefined', () => {
    const ctx = buildToolExecuteContext<'my_tool', Record<string, unknown>>(
      turnContext,
      undefined,
      'my_tool',
      undefined,
    );

    // Should not throw
    ctx.setSharedContext({
      key: 'value',
    } as Record<string, unknown>);

    // Still empty
    expect(ctx.shared).toEqual({});
  });

  it('should return frozen snapshots from shared getter', () => {
    const store = new ToolContextStore({
      [SHARED_CONTEXT_KEY]: {
        key: 'value',
      },
    });

    const ctx = buildToolExecuteContext<'my_tool', Record<string, unknown>>(
      turnContext,
      store,
      'my_tool',
      undefined,
    );

    const snapshot = ctx.shared;
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('should reflect setSharedContext changes immediately via live getter', () => {
    const store = new ToolContextStore({});
    const sharedSchema = z4.object({
      counter: z4.number().optional(),
    });

    const ctx = buildToolExecuteContext<
      'my_tool',
      Record<string, unknown>,
      {
        counter?: number;
      }
    >(turnContext, store, 'my_tool', undefined, sharedSchema);

    expect(ctx.shared).toEqual({});

    ctx.setSharedContext({
      counter: 1,
    });
    expect(ctx.shared).toEqual({
      counter: 1,
    });

    ctx.setSharedContext({
      counter: 2,
    });
    expect(ctx.shared).toEqual({
      counter: 2,
    });
  });
});

//#endregion

//#region sharedContext seeds the store

describe('shared context seeds the store via SHARED_CONTEXT_KEY', () => {
  it('should seed shared context into ToolContextStore', () => {
    const store = new ToolContextStore({
      [SHARED_CONTEXT_KEY]: {
        sessionId: 'sess-1',
        mode: 'sandbox',
      },
    });

    expect(store.getToolContext(SHARED_CONTEXT_KEY)).toEqual({
      sessionId: 'sess-1',
      mode: 'sandbox',
    });
  });

  it('should be accessible from tool execute context after seeding', () => {
    const turnContext: TurnContext = {
      numberOfTurns: 0,
    };
    const store = new ToolContextStore({
      [SHARED_CONTEXT_KEY]: {
        apiUrl: 'https://example.com',
      },
    });

    const ctx = buildToolExecuteContext<'my_tool', Record<string, unknown>>(
      turnContext,
      store,
      'my_tool',
      undefined,
    );

    expect(ctx.shared).toEqual({
      apiUrl: 'https://example.com',
    });
  });

  it('should not interfere with tool-specific context', () => {
    const turnContext: TurnContext = {
      numberOfTurns: 0,
    };
    const store = new ToolContextStore({
      [SHARED_CONTEXT_KEY]: {
        global: 'data',
      },
      my_tool: {
        toolSpecific: 'value',
      },
    });
    const schema = z4.object({
      toolSpecific: z4.string(),
    });

    const ctx = buildToolExecuteContext<
      'my_tool',
      {
        toolSpecific: string;
      }
    >(turnContext, store, 'my_tool', schema);

    expect(ctx.shared).toEqual({
      global: 'data',
    });
    expect(ctx.local).toEqual({
      toolSpecific: 'value',
    });
  });
});

//#endregion

//#region SHARED_CONTEXT_KEY constant

describe('SHARED_CONTEXT_KEY', () => {
  it('should be "shared"', () => {
    expect(SHARED_CONTEXT_KEY).toBe('shared');
  });
});

//#endregion

//#region Context setters store schema-validated values

describe('context setters store schema-validated values', () => {
  const turnContext: TurnContext = {
    numberOfTurns: 1,
  };

  it('setSharedContext stores the parsed output of field transforms', () => {
    const store = new ToolContextStore({
      [SHARED_CONTEXT_KEY]: {
        level: 0,
      },
    });
    const sharedSchema = z4.object({
      level: z4.number().transform((n) => Math.min(n, 0)),
    });

    const ctx = buildToolExecuteContext<
      'my_tool',
      Record<string, unknown>,
      {
        level: number;
      }
    >(turnContext, store, 'my_tool', undefined, sharedSchema);

    ctx.setSharedContext({
      level: 1,
    });

    expect(ctx.shared).toEqual({
      level: 0,
    });
  });

  it('setContext stores the parsed output of field transforms', () => {
    const store = new ToolContextStore({
      my_tool: {
        mode: 'read',
      },
    });
    const schema = z4.object({
      mode: z4.string().transform((s) => s.trim().toLowerCase()),
    });

    const ctx = buildToolExecuteContext<
      'my_tool',
      {
        mode: string;
      }
    >(turnContext, store, 'my_tool', schema);

    ctx.setContext({
      mode: '  WRITE ',
    });

    expect(ctx.local).toEqual({
      mode: 'write',
    });
  });

  it('setSharedContext rejects an update that breaks an object-level refinement', () => {
    const initial = {
      role: 'guest',
      access: 'read',
    };
    const store = new ToolContextStore({
      [SHARED_CONTEXT_KEY]: initial,
    });
    const sharedSchema = z4
      .object({
        role: z4.enum([
          'guest',
          'staff',
        ]),
        access: z4.enum([
          'read',
          'write',
        ]),
      })
      .refine((v) => v.access !== 'write' || v.role === 'staff');

    const ctx = buildToolExecuteContext<
      'my_tool',
      Record<string, unknown>,
      {
        role: 'guest' | 'staff';
        access: 'read' | 'write';
      }
    >(turnContext, store, 'my_tool', undefined, sharedSchema);

    expect(() =>
      ctx.setSharedContext({
        access: 'write',
      }),
    ).toThrow();
    expect(ctx.shared).toEqual(initial);

    ctx.setSharedContext({
      role: 'staff',
    });
    ctx.setSharedContext({
      access: 'write',
    });
    expect(ctx.shared).toEqual({
      role: 'staff',
      access: 'write',
    });
  });
});

//#endregion

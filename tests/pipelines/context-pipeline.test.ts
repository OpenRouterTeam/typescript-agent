import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  buildToolExecuteContext,
  resolveContext,
  ToolContextStore,
} from '../../src/lib/tool-context.js';
import { buildTurnContext } from '../../src/lib/turn-context.js';

describe('Context pipeline: build -> resolve -> store -> execute', () => {
  it('turn 0 with context: buildTurnContext -> resolveContext -> ToolContextStore -> buildToolExecuteContext -> tool reads local', async () => {
    // Build turn context
    const turnCtx = buildTurnContext({
      numberOfTurns: 0,
    });
    expect(turnCtx.numberOfTurns).toBe(0);

    // Resolve context via function
    const contextFn = () => ({
      apiKey: 'secret-123',
    });
    const resolved = await resolveContext(contextFn, turnCtx);
    expect(resolved).toEqual({
      apiKey: 'secret-123',
    });

    // Populate store
    const store = new ToolContextStore({
      myTool: resolved,
    });

    // Build tool execute context
    const _toolFn = {
      name: 'myTool',
      inputSchema: z.object({}),
      contextSchema: z.object({
        apiKey: z.string(),
      }),
    };
    const contextSchema = z.object({
      apiKey: z.string(),
    });
    const execCtx = buildToolExecuteContext(turnCtx, store, 'myTool', contextSchema);

    // Tool reads from local
    expect(execCtx.local).toEqual({
      apiKey: 'secret-123',
    });
    expect(execCtx.numberOfTurns).toBe(0);
  });

  it('shared context mutation: tool A reads count=0 -> sets count=1 -> tool B reads count=1', () => {
    const store = new ToolContextStore({
      shared: {
        count: 0,
      },
    });
    const turnCtx = buildTurnContext({
      numberOfTurns: 1,
    });

    const _sharedToolFn = {
      name: 'shared',
      inputSchema: z.object({}),
      contextSchema: z.object({
        count: z.number(),
      }),
    };

    const contextSchema = z.object({
      count: z.number(),
    });

    // Tool A reads shared.count === 0
    const ctxA = buildToolExecuteContext(turnCtx, store, 'shared', contextSchema);
    expect(ctxA.local).toEqual({
      count: 0,
    });

    // Tool A updates shared context
    store.setToolContext('shared', {
      count: 1,
    });

    // Tool B reads shared.count === 1
    const ctxB = buildToolExecuteContext(turnCtx, store, 'shared', contextSchema);
    expect(ctxB.local).toEqual({
      count: 1,
    });
  });
});

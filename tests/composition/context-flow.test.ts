import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  buildToolExecuteContext,
  resolveContext,
  ToolContextStore,
} from '../../src/lib/tool-context.js';
import { buildTurnContext } from '../../src/lib/turn-context.js';

describe('Context flow: turn context -> tool execute context -> tool function', () => {
  it('buildToolExecuteContext receives TurnContext from buildTurnContext -> tool execute receives correct numberOfTurns', () => {
    const turnCtx = buildTurnContext({
      numberOfTurns: 3,
    });
    const store = new ToolContextStore();

    const execCtx = buildToolExecuteContext(turnCtx, store, 'test', undefined);
    expect(execCtx.numberOfTurns).toBe(3);
  });

  it('resolveContext passes TurnContext to context function -> result populates ToolContextStore -> buildToolExecuteContext.local reads from store', async () => {
    const turnCtx = buildTurnContext({
      numberOfTurns: 2,
    });
    const contextFn = (ctx: { numberOfTurns: number }) => ({
      apiKey: `key-for-turn-${ctx.numberOfTurns}`,
    });

    const resolved = await resolveContext(contextFn, turnCtx);
    expect(resolved).toEqual({
      apiKey: 'key-for-turn-2',
    });

    const store = new ToolContextStore({
      test: resolved,
    });
    const contextSchema = z.object({
      apiKey: z.string(),
    });

    const execCtx = buildToolExecuteContext(turnCtx, store, 'test', contextSchema);
    expect(execCtx.local).toEqual({
      apiKey: 'key-for-turn-2',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { buildToolExecuteContext, ToolContextStore } from '../../src/lib/tool-context.js';
import { buildTurnContext } from '../../src/lib/turn-context.js';

describe('ToolContextStore -> buildToolExecuteContext -> tool execution', () => {
  it('tool execute receives context where local reflects store data set before execution', () => {
    const store = new ToolContextStore({
      myTool: {
        apiKey: 'key-123',
      },
    });
    const turnCtx = buildTurnContext({
      numberOfTurns: 1,
    });
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
    expect(execCtx.local).toEqual({
      apiKey: 'key-123',
    });
  });

  it('tool calls setContext -> store updated -> next tool reads updated value via local', () => {
    const store = new ToolContextStore({
      toolA: {
        count: 0,
      },
      toolB: {},
    });
    const turnCtx = buildTurnContext({
      numberOfTurns: 1,
    });
    const contextSchema = z.object({
      count: z.number(),
    });

    const execCtxA = buildToolExecuteContext(turnCtx, store, 'toolA', contextSchema);
    expect(execCtxA.local).toEqual({
      count: 0,
    });

    // Simulate tool A updating context
    store.mergeToolContext('toolA', {
      count: 42,
    });

    // Tool A now reads updated value
    const execCtxA2 = buildToolExecuteContext(turnCtx, store, 'toolA', contextSchema);
    expect(execCtxA2.local).toEqual({
      count: 42,
    });
  });
});

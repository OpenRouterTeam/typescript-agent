import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';
import { executeTool } from '../../src/lib/tool-executor.js';

describe('executeTool dispatches via tool type guards', () => {
  const regularTool = tool({
    name: 'add',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    execute: async (args) => args.a + args.b,
  });

  const generatorTool = tool({
    name: 'stream_add',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    eventSchema: z.object({
      progress: z.number(),
    }),
    outputSchema: z.object({
      sum: z.number(),
    }),
    execute: async function* (args) {
      yield {
        progress: 50,
      };
      return {
        sum: args.a + args.b,
      };
    },
  });

  const manualTool = tool({
    name: 'manual_op',
    inputSchema: z.object({
      x: z.string(),
    }),
  });

  const toolCall = {
    id: 'tc_1',
    name: 'test',
    arguments: {
      a: 2,
      b: 3,
    },
  };
  const turnCtx = {
    numberOfTurns: 1,
  };

  it('dispatches regular tool to executeRegularTool path because isRegularExecuteTool returns true', async () => {
    const result = await executeTool(regularTool, toolCall, turnCtx);
    expect(result.toolCallId).toBe('tc_1');
    expect(result.result).toBe(5);
    expect(result).not.toHaveProperty('preliminaryResults');
  });

  it('dispatches generator tool to executeGeneratorTool path because isGeneratorTool returns true', async () => {
    const result = await executeTool(generatorTool, toolCall, turnCtx);
    expect(result.toolCallId).toBe('tc_1');
    expect(result.result).toEqual({
      sum: 5,
    });
    expect(result).toHaveProperty('preliminaryResults');
  });

  it('rejects manual tool because hasExecuteFunction returns false', async () => {
    const manualCall = {
      id: 'tc_1',
      name: 'manual_op',
      arguments: {
        x: 'hi',
      },
    };
    await expect(executeTool(manualTool as any, manualCall, turnCtx)).rejects.toThrow();
  });
});

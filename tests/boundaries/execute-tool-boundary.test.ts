import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';
import { executeGeneratorTool, executeRegularTool } from '../../src/lib/tool-executor.js';

describe('executeRegularTool vs executeGeneratorTool - structural boundary', () => {
  const regularTool = tool({
    name: 'regular',
    inputSchema: z.object({
      x: z.number(),
    }),
    execute: async (args) => args.x * 2,
  });

  const generatorTool = tool({
    name: 'generator',
    inputSchema: z.object({
      x: z.number(),
    }),
    eventSchema: z.object({
      progress: z.number(),
    }),
    outputSchema: z.object({
      result: z.number(),
    }),
    execute: async function* (args) {
      yield {
        progress: 50,
      };
      return {
        result: args.x * 2,
      };
    },
  });

  const toolCall = {
    id: 'tc_1',
    name: 'test',
    arguments: {
      x: 5,
    },
  };
  const turnCtx = {
    numberOfTurns: 1,
  };

  it('executeRegularTool throws when given a generator tool', async () => {
    await expect(executeRegularTool(generatorTool, toolCall, turnCtx)).rejects.toThrow();
  });

  it('executeGeneratorTool throws when given a regular tool', async () => {
    await expect(executeGeneratorTool(regularTool, toolCall, turnCtx)).rejects.toThrow();
  });

  it('executeRegularTool result has NO preliminaryResults', async () => {
    const result = await executeRegularTool(regularTool, toolCall, turnCtx);
    expect(result).not.toHaveProperty('preliminaryResults');
  });

  it('executeGeneratorTool result HAS preliminaryResults array', async () => {
    const result = await executeGeneratorTool(generatorTool, toolCall, turnCtx);
    expect(result).toHaveProperty('preliminaryResults');
    expect(Array.isArray(result.preliminaryResults)).toBe(true);
  });
});

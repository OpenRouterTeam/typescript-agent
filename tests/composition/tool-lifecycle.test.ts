import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';
import {
  convertToolsToAPIFormat,
  executeTool,
  findToolByName,
} from '../../src/lib/tool-executor.js';
import { isGeneratorTool, isManualTool, isRegularExecuteTool } from '../../src/lib/tool-types.js';

describe('Tool lifecycle: definition -> classification -> execution', () => {
  const regularTool = tool({
    name: 'add',
    description: 'Add numbers',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    execute: async (args) => args.a + args.b,
  });

  const generatorTool = tool({
    name: 'stream_add',
    description: 'Stream add',
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
    description: 'Manual tool',
    inputSchema: z.object({
      x: z.string(),
    }),
    execute: false,
  });

  it('tool() output is accepted by isRegularExecuteTool / isGeneratorTool / isManualTool', () => {
    expect(isRegularExecuteTool(regularTool)).toBe(true);
    expect(isGeneratorTool(generatorTool)).toBe(true);
    expect(isManualTool(manualTool)).toBe(true);
  });

  it('tool() output is accepted by convertToolsToAPIFormat', () => {
    const apiTools = convertToolsToAPIFormat([
      regularTool,
      generatorTool,
      manualTool,
    ]);
    expect(apiTools).toHaveLength(3);
    expect(apiTools[0]!.name).toBe('add');
    expect(apiTools[0]!.type).toBe('function');
    expect(apiTools[1]!.name).toBe('stream_add');
    expect(apiTools[2]!.name).toBe('manual_op');
  });

  it('extractToolCallsFromResponse output shape is accepted by findToolByName + executeTool', async () => {
    const tools = [
      regularTool,
      generatorTool,
      manualTool,
    ];
    const toolCallShape = {
      id: 'tc_1',
      name: 'add',
      arguments: {
        a: 1,
        b: 2,
      },
    };

    const found = findToolByName(tools, toolCallShape.name);
    expect(found).toBeDefined();

    const result = await executeTool(found!, toolCallShape, {
      numberOfTurns: 1,
    });
    expect(result.toolCallId).toBe('tc_1');
    expect(result.result).toBe(3);
  });
});

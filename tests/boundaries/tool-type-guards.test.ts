import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';
import {
  hasExecuteFunction,
  isGeneratorTool,
  isManualTool,
  isRegularExecuteTool,
} from '../../src/lib/tool-types.js';

describe('Tool type guards - mutual exclusion across 4 classifiers', () => {
  const regularTool = tool({
    name: 'regular',
    description: 'A regular tool',
    inputSchema: z.object({
      x: z.number(),
    }),
    execute: async (args) => args.x * 2,
  });

  const generatorTool = tool({
    name: 'generator',
    description: 'A generator tool',
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

  const manualTool = tool({
    name: 'manual',
    description: 'A manual tool',
    inputSchema: z.object({
      x: z.number(),
    }),
    execute: false,
  });

  it('regular tool: hasExecuteFunction=T, isRegularExecuteTool=T, isGeneratorTool=F, isManualTool=F', () => {
    expect(hasExecuteFunction(regularTool)).toBe(true);
    expect(isRegularExecuteTool(regularTool)).toBe(true);
    expect(isGeneratorTool(regularTool)).toBe(false);
    expect(isManualTool(regularTool)).toBe(false);
  });

  it('generator tool: hasExecuteFunction=T, isRegularExecuteTool=F, isGeneratorTool=T, isManualTool=F', () => {
    expect(hasExecuteFunction(generatorTool)).toBe(true);
    expect(isRegularExecuteTool(generatorTool)).toBe(false);
    expect(isGeneratorTool(generatorTool)).toBe(true);
    expect(isManualTool(generatorTool)).toBe(false);
  });

  it('manual tool: hasExecuteFunction=F, isRegularExecuteTool=F, isGeneratorTool=F, isManualTool=T', () => {
    expect(hasExecuteFunction(manualTool)).toBe(false);
    expect(isRegularExecuteTool(manualTool)).toBe(false);
    expect(isGeneratorTool(manualTool)).toBe(false);
    expect(isManualTool(manualTool)).toBe(true);
  });

  it('no tool satisfies both isRegularExecuteTool and isGeneratorTool', () => {
    const allTools = [
      regularTool,
      generatorTool,
      manualTool,
    ];
    for (const t of allTools) {
      const isRegular = isRegularExecuteTool(t);
      const isGenerator = isGeneratorTool(t);
      expect(isRegular && isGenerator).toBe(false);
    }
  });
});

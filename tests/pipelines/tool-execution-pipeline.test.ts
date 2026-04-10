import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';
import {
  executeTool,
  formatToolExecutionError,
  formatToolResultForModel,
} from '../../src/lib/tool-executor.js';

describe('Full tool execution pipeline: definition -> dispatch -> validate -> execute -> format', () => {
  it('regular tool: tool() -> executeTool -> validates -> executes -> formatToolResultForModel produces JSON', async () => {
    const addTool = tool({
      name: 'add',
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      outputSchema: z.object({
        sum: z.number(),
      }),
      execute: async (args) => ({
        sum: args.a + args.b,
      }),
    });

    const toolCall = {
      id: 'tc_1',
      name: 'add',
      arguments: {
        a: 2,
        b: 3,
      },
    };
    const result = await executeTool(addTool, toolCall, {
      numberOfTurns: 1,
    });

    // Dispatch worked (regular path)
    expect(result.toolCallId).toBe('tc_1');
    expect(result.toolName).toBe('add');
    // Execution worked
    expect(result.result).toEqual({
      sum: 5,
    });
    // No error
    expect(result.error).toBeUndefined();

    // Format for model
    const formatted = formatToolResultForModel(result);
    expect(typeof formatted).toBe('string');
    const parsed = JSON.parse(formatted);
    expect(parsed.sum).toBe(5);
  });

  it('generator tool: tool() with eventSchema -> executeTool -> generator yields events -> result has both', async () => {
    const streamTool = tool({
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
        yield {
          progress: 100,
        };
        return {
          sum: args.a + args.b,
        };
      },
    });

    const toolCall = {
      id: 'tc_2',
      name: 'stream_add',
      arguments: {
        a: 3,
        b: 4,
      },
    };
    const result = await executeTool(streamTool, toolCall, {
      numberOfTurns: 1,
    });

    // Dispatch worked (generator path)
    expect(result.toolCallId).toBe('tc_2');
    // Generator yielded events
    expect(result.preliminaryResults).toHaveLength(2);
    expect(result.preliminaryResults![0]).toEqual({
      progress: 50,
    });
    expect(result.preliminaryResults![1]).toEqual({
      progress: 100,
    });
    // Final result
    expect(result.result).toEqual({
      sum: 7,
    });
  });

  it('error pipeline: invalid input -> executeTool -> caught -> ToolExecutionResult has error -> formatToolExecutionError includes details', async () => {
    const strictTool = tool({
      name: 'strict',
      inputSchema: z.object({
        count: z.number().min(1),
      }),
      execute: async (args) => args.count,
    });

    const toolCall = {
      id: 'tc_3',
      name: 'strict',
      arguments: {
        count: -5,
      },
    };
    const result = await executeTool(strictTool, toolCall, {
      numberOfTurns: 1,
    });

    // Error was caught
    expect(result.error).toBeDefined();
    expect(result.result).toBeNull();

    // Format error includes details
    const errorFormatted = formatToolExecutionError(result.error!, toolCall);
    expect(errorFormatted).toContain('strict');
  });
});

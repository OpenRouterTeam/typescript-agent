import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';
import {
  createInitialState,
  createRejectedResult,
  createUnsentResult,
  partitionToolCalls,
  unsentResultsToAPIFormat,
  updateState,
} from '../../src/lib/conversation-state.js';
import { executeTool } from '../../src/lib/tool-executor.js';

describe('Approval -> execution -> state update pipeline', () => {
  it('approval workflow: partition -> execute auto -> create results -> format -> update state', async () => {
    const autoTool = tool({
      name: 'search',
      inputSchema: z.object({
        q: z.string(),
      }),
      execute: async (args) => ({
        results: [
          `found: ${args.q}`,
        ],
      }),
    });

    const approvalTool = tool({
      name: 'delete',
      inputSchema: z.object({
        target: z.string(),
      }),
      requireApproval: true,
      execute: async () => 'deleted',
    });

    const toolCalls = [
      {
        id: 'tc_1',
        name: 'search',
        arguments: {
          q: 'test',
        },
      },
      {
        id: 'tc_2',
        name: 'delete',
        arguments: {
          target: 'file.txt',
        },
      },
    ];

    const tools = [
      autoTool,
      approvalTool,
    ];

    // Step 1: Partition
    const partition = await partitionToolCalls(toolCalls, tools);
    expect(partition.autoExecute).toHaveLength(1);
    expect(partition.requiresApproval).toHaveLength(1);

    // Step 2: Execute auto tool
    const autoResult = await executeTool(autoTool, partition.autoExecute[0]!, {
      numberOfTurns: 1,
    });
    expect(autoResult.result).toEqual({
      results: [
        'found: test',
      ],
    });

    // Step 3: Create results
    const unsent = createUnsentResult('tc_1', 'search', autoResult.result);
    const rejected = createRejectedResult('tc_2', 'delete');

    // Step 4: Format for API
    const formatted = unsentResultsToAPIFormat([
      unsent,
      rejected,
    ]);
    expect(formatted).toHaveLength(2);
    expect(formatted[0]!.type).toBe('function_call_output');
    expect(formatted[1]!.type).toBe('function_call_output');

    // Step 5: Update state
    const state = createInitialState();
    const updated = updateState(state, {
      status: 'completed',
    });
    expect(updated.status).toBe('completed');
    expect(updated.id).toBe(state.id);
  });
});

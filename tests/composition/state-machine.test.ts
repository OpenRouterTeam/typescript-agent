import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';
import {
  createRejectedResult,
  createUnsentResult,
  partitionToolCalls,
  unsentResultsToAPIFormat,
} from '../../src/lib/conversation-state.js';

describe('State machine: state -> approval -> resumption', () => {
  it('partitionToolCalls uses toolRequiresApproval internally -> partitioned results are consistent', async () => {
    const approvalTool = tool({
      name: 'dangerous',
      inputSchema: z.object({
        target: z.string(),
      }),
      requireApproval: true,
      execute: async () => 'deleted',
    });

    const safeTool = tool({
      name: 'safe',
      inputSchema: z.object({
        q: z.string(),
      }),
      execute: async () => 'result',
    });

    const toolCalls = [
      {
        id: 'tc_1',
        name: 'dangerous',
        arguments: {
          target: 'file.txt',
        },
      },
      {
        id: 'tc_2',
        name: 'safe',
        arguments: {
          q: 'hello',
        },
      },
    ];

    const tools = [
      approvalTool,
      safeTool,
    ];
    const partition = await partitionToolCalls(toolCalls, tools);

    expect(partition.requiresApproval).toHaveLength(1);
    expect(partition.autoExecute).toHaveLength(1);
    expect(partition.requiresApproval[0]!.name).toBe('dangerous');
    expect(partition.autoExecute[0]!.name).toBe('safe');
  });

  it('createUnsentResult / createRejectedResult output accepted by unsentResultsToAPIFormat', () => {
    const unsent = createUnsentResult('tc_1', 'search', {
      data: 'found',
    });
    const rejected = createRejectedResult('tc_2', 'delete');

    const formatted = unsentResultsToAPIFormat([
      unsent,
      rejected,
    ]);
    expect(formatted).toHaveLength(2);
    expect(formatted[0]!.callId).toBe('tc_1');
    expect(formatted[0]!.type).toBe('function_call_output');
    expect(formatted[1]!.callId).toBe('tc_2');
    expect(formatted[1]!.type).toBe('function_call_output');
  });
});

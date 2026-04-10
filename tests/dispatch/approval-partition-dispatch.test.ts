import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';
import { partitionToolCalls } from '../../src/lib/conversation-state.js';

describe('Approval partitioning dispatches via tool-level vs call-level checks', () => {
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

  it('partitionToolCalls with call-level check -> call-level overrides tool-level requireApproval', async () => {
    // Call-level check says: no approval needed for anything
    const callLevelCheck = async () => false;
    const context = {
      numberOfTurns: 1,
    };
    const partition = await partitionToolCalls(
      toolCalls,
      [
        approvalTool,
        safeTool,
      ],
      context,
      callLevelCheck,
    );
    // Call-level override: both should be auto-execute
    expect(partition.autoExecute).toHaveLength(2);
    expect(partition.requiresApproval).toHaveLength(0);
  });

  it('partitionToolCalls without call-level check -> falls back to each tool requireApproval', async () => {
    const context = {
      numberOfTurns: 1,
    };
    const partition = await partitionToolCalls(
      toolCalls,
      [
        approvalTool,
        safeTool,
      ],
      context,
    );
    expect(partition.requiresApproval).toHaveLength(1);
    expect(partition.requiresApproval[0]!.name).toBe('dangerous');
    expect(partition.autoExecute).toHaveLength(1);
    expect(partition.autoExecute[0]!.name).toBe('safe');
  });
});

import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import type { ConversationState, StateAccessor, Tool } from '../../src/lib/tool-types.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

// Import ModelResult AFTER vi.mock so the transport mock is wired in.
const { ModelResult } = await import('../../src/lib/model-result.js');

function makeResponse(output: models.OpenResponsesResult['output']): models.OpenResponsesResult {
  return {
    id: 'resp_1',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output,
    error: null,
    incompleteDetails: null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
  };
}

function functionCall(callId: string, name: string): models.OutputFunctionCallItem {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    callId,
    name,
    arguments: '{"v":"x"}',
    status: 'completed',
  };
}

function createMemoryAccessor<TTools extends readonly Tool[]>() {
  let state: ConversationState<TTools> | null = null;
  const accessor: StateAccessor<TTools> = {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
  };
  return {
    accessor,
    get: () => state,
  };
}

function makeTools() {
  const autoExecute = vi.fn(async () => ({
    ok: true,
  }));
  const gatedExecute = vi.fn(async () => ({
    ok: true,
  }));
  const auto = tool({
    name: 'auto',
    inputSchema: z.object({
      v: z.string(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
    }),
    execute: autoExecute,
  });
  const gated = tool({
    name: 'gated',
    inputSchema: z.object({
      v: z.string(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
    }),
    requireApproval: true,
    execute: gatedExecute,
  });
  return {
    tools: [
      auto,
      gated,
    ] as const,
    autoExecute,
    gatedExecute,
  };
}

describe('stopWhen is evaluated before the approval check on the first response', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: makeResponse([
        functionCall('call_auto', 'auto'),
        functionCall('call_gated', 'gated'),
      ]),
    });
  });

  it('does not run an auto-executable sibling of an approval-gated call when stopWhen is already met', async () => {
    const { tools, autoExecute, gatedExecute } = makeTools();
    const memory = createMemoryAccessor<typeof tools>();
    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'go',
      },
      client: {} as OpenRouterCore,
      tools,
      state: memory.accessor,
      stopWhen: () => true,
      allowFinalResponse: false,
    });

    await result.getResponse();

    expect(autoExecute).not.toHaveBeenCalled();
    expect(gatedExecute).not.toHaveBeenCalled();
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    const saved = memory.get();
    expect(saved?.status).toBe('awaiting_approval');
    expect(saved?.pendingToolCalls?.map((tc) => tc.id)).toEqual([
      'call_gated',
    ]);
    // The skipped sibling still gets a matching output for the resume request.
    expect(saved?.unsentToolResults).toEqual([
      {
        callId: 'call_auto',
        name: 'auto',
        output: null,
        error: 'Tool execution skipped: stop condition met',
      },
    ]);
    expect(await result.requiresApproval()).toBe(true);
  });

  it('still runs the auto-executable sibling when stopWhen is not met', async () => {
    const { tools, autoExecute } = makeTools();
    const memory = createMemoryAccessor<typeof tools>();
    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'go',
      },
      client: {} as OpenRouterCore,
      tools,
      state: memory.accessor,
      stopWhen: () => false,
      allowFinalResponse: false,
    });

    await result.getResponse();

    expect(autoExecute).toHaveBeenCalledTimes(1);
    const saved = memory.get();
    expect(saved?.status).toBe('awaiting_approval');
    expect(saved?.pendingToolCalls?.map((tc) => tc.id)).toEqual([
      'call_gated',
    ]);
    expect(saved?.unsentToolResults?.map((r) => r.callId)).toEqual([
      'call_auto',
    ]);
  });
});

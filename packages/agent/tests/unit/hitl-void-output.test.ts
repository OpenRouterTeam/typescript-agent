import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import { applyOnResponseReceivedHooks } from '../../src/lib/tool-executor.js';
import type {
  ConversationState,
  StateAccessor,
  Tool,
  TurnContext,
} from '../../src/lib/tool-types.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

const { ModelResult } = await import('../../src/lib/model-result.js');

function createMemoryAccessor<TTools extends readonly Tool[]>(): {
  accessor: StateAccessor<TTools>;
  get: () => ConversationState<TTools> | null;
} {
  let state: ConversationState<TTools> | null = null;
  return {
    accessor: {
      load: async () => state,
      save: async (next) => {
        state = next;
      },
    },
    get: () => state,
  };
}

describe('HITL onResponseReceived undefined/void output serialization', () => {
  const turnContext: TurnContext = {
    numberOfTurns: 1,
  };

  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('produces a valid string output when onResponseReceived returns undefined for a void outputSchema', async () => {
    const ack = tool({
      name: 'ack_step',
      inputSchema: z.object({
        step: z.string(),
      }),
      outputSchema: z.void(),
      onToolCalled: async () => null,
      onResponseReceived: async () => undefined,
    });

    const input: models.InputsUnion = [
      {
        type: 'function_call',
        id: 'fc_1',
        callId: 'call_1',
        name: 'ack_step',
        arguments: '{"step":"deploy"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        id: 'fco_1',
        callId: 'call_1',
        output: 'null',
      },
    ];

    const processed = (await applyOnResponseReceivedHooks(
      input,
      [
        ack,
      ],
      turnContext,
    )) as models.InputsUnion1[];
    const outputItem = processed.find(
      (item): item is models.FunctionCallOutputItem =>
        'type' in item && item.type === 'function_call_output',
    );

    expect(outputItem).toBeDefined();
    expect(typeof outputItem?.output).toBe('string');
  });

  it('resumes ModelResult without undefined function_call_output when onResponseReceived returns undefined', async () => {
    const ack = tool({
      name: 'ack_step',
      inputSchema: z.object({
        step: z.string(),
      }),
      outputSchema: z.void(),
      onToolCalled: async () => null,
      onResponseReceived: async () => undefined,
    });
    const tools = [
      ack,
    ] as const;
    const { accessor } = createMemoryAccessor<typeof tools>();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: {
        id: 'resp_1',
        object: 'response',
        createdAt: 0,
        model: 'test-model',
        status: 'completed',
        completedAt: 0,
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            callId: 'call_1',
            name: 'ack_step',
            arguments: '{"step":"deploy"}',
            status: 'completed',
          },
        ],
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
      } satisfies models.OpenResponsesResult,
    });

    await new ModelResult({
      request: {
        model: 'test-model',
        input: 'deploy it',
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
    }).getResponse();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: {
        id: 'resp_2',
        object: 'response',
        createdAt: 0,
        model: 'test-model',
        status: 'completed',
        completedAt: 0,
        output: [
          {
            type: 'message',
            id: 'msg_2',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'done',
                annotations: [],
              },
            ],
          },
        ],
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
      } satisfies models.OpenResponsesResult,
    });

    await new ModelResult({
      request: {
        model: 'test-model',
        input: [
          {
            type: 'function_call_output',
            id: 'fco_1',
            callId: 'call_1',
            output: 'null',
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
    }).getResponse();

    const secondReqInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest
      ?.input as Array<{
      type?: string;
      callId?: string;
      output?: unknown;
    }>;
    const sentOutput = secondReqInput.find(
      (item) => item.type === 'function_call_output' && item.callId === 'call_1',
    );
    expect(typeof sentOutput?.output).toBe('string');
  });
});

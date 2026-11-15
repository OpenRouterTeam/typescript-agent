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

const { ModelResult } = await import('../../src/lib/model-result.js');

const SECRET = 'SENTINEL-PRIVATE-VALUE';
const MASK = '[masked]';

function makeResponse(
  id: string,
  output: models.OpenResponsesResult['output'],
): models.OpenResponsesResult {
  return {
    id,
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

function toolCallResponse(id: string, callId: string, args: string) {
  return {
    ok: true,
    value: makeResponse(id, [
      {
        type: 'function_call',
        id: `fc_${callId}`,
        callId,
        name: 'lookup',
        arguments: args,
        status: 'completed',
      },
    ]),
  };
}

function textResponse(id: string) {
  return {
    ok: true,
    value: makeResponse(id, [
      {
        type: 'message',
        id: `msg_${id}`,
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
    ]),
  };
}

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

/** Every function_call_output the SDK sent to the model, across all requests. */
function sentToolOutputs(): unknown[] {
  return mockBetaResponsesSend.mock.calls.flatMap((call) => {
    const input = call[1]?.responsesRequest?.input;
    return Array.isArray(input)
      ? input
          .filter((item: { type?: string }) => item?.type === 'function_call_output')
          .map((item: { output: unknown }) => item.output)
      : [];
  });
}

const request = {
  model: 'test-model',
  input: 'look it up',
};

beforeEach(() => {
  mockBetaResponsesSend.mockReset();
});

describe('toModelOutput receives the parsed input that execute receives', () => {
  it('passes inputSchema-normalized arguments to toModelOutput', async () => {
    const executeInputs: unknown[] = [];
    const mapperInputs: unknown[] = [];
    const lookup = tool({
      name: 'lookup',
      inputSchema: z.object({
        access: z.string().toLowerCase(),
        verbose: z.boolean().default(false),
      }),
      execute: async (input) => {
        executeInputs.push(input);
        return {
          secret: SECRET,
        };
      },
      toModelOutput: ({ input, output }) => {
        mapperInputs.push(input);
        return {
          type: 'content',
          value: [
            {
              type: 'input_text',
              text: input.access === 'private' ? MASK : output.secret,
            },
          ],
        };
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce(toolCallResponse('resp_1', 'call_1', '{"access":"PRIVATE"}'))
      .mockResolvedValueOnce(textResponse('resp_2'));

    await new ModelResult({
      request,
      client: {} as OpenRouterCore,
      tools: [
        lookup,
      ] as const,
    }).getResponse();

    const parsed = {
      access: 'private',
      verbose: false,
    };
    expect(executeInputs).toEqual([
      parsed,
    ]);
    expect(mapperInputs).toEqual([
      parsed,
    ]);
    expect(JSON.stringify(sentToolOutputs())).not.toContain(SECRET);
  });
});

describe('toModelOutput runs on the approval-resume path', () => {
  it('maps the output of an approved call before sending it to the model', async () => {
    const mapper = vi.fn(() => ({
      type: 'content' as const,
      value: [
        {
          type: 'input_text' as const,
          text: MASK,
        },
      ],
    }));
    const execute = vi.fn(async () => ({
      secret: SECRET,
    }));
    const lookup = tool({
      name: 'lookup',
      inputSchema: z.object({
        access: z.string().toLowerCase(),
      }),
      requireApproval: true,
      execute,
      toModelOutput: mapper,
    });
    const tools = [
      lookup,
    ] as const;
    const { accessor, get } = createMemoryAccessor<typeof tools>();

    mockBetaResponsesSend.mockResolvedValueOnce(
      toolCallResponse('resp_1', 'call_1', '{"access":"PRIVATE"}'),
    );
    await new ModelResult({
      request,
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
    }).getResponse();
    expect(get()?.status).toBe('awaiting_approval');
    expect(execute).not.toHaveBeenCalled();

    mockBetaResponsesSend.mockResolvedValueOnce(textResponse('resp_2'));
    await new ModelResult({
      request: {
        ...request,
        input: [],
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
      approveToolCalls: [
        'call_1',
      ],
    }).getResponse();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(mapper).toHaveBeenCalledTimes(1);
    expect(mapper).toHaveBeenCalledWith({
      input: {
        access: 'private',
      },
      output: {
        secret: SECRET,
      },
    });
    const outputs = sentToolOutputs();
    expect(outputs).toContainEqual([
      {
        type: 'input_text',
        text: MASK,
      },
    ]);
    expect(JSON.stringify(outputs)).not.toContain(SECRET);
  });
});

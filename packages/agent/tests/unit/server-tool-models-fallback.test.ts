import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callModel } from '../../src/inner-loop/call-model.js';
import { serverTool } from '../../src/lib/tool.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

function makeResponse(
  id: string,
  model: string,
  output: models.OpenResponsesResult['output'],
): models.OpenResponsesResult {
  return {
    id,
    object: 'response',
    createdAt: 0,
    model,
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
  } as models.OpenResponsesResult;
}

const client = {
  _options: {},
} as OpenRouterCore;

describe('Issue #121: server tools with model fallback via models', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('populates model from models[0] when model is omitted (#121)', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', 'mistralai/mistral-small-2603', [
        {
          id: 'item_1',
          type: 'openrouter:datetime',
          status: 'completed',
          additionalProperties: {
            datetime: '2026-09-05T00:00:00Z',
          },
        } as models.OutputServerToolItem,
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'Today is Saturday.',
              annotations: [],
            },
          ],
        },
      ]),
    });

    const result = callModel(client, {
      models: [
        'mistralai/mistral-small-2603',
        'mistralai/mistral-large-2512',
      ],
      input: 'What day is it?',
      tools: [
        serverTool({
          type: 'openrouter:datetime',
        }),
      ],
    });

    const text = await result.getText();
    expect(text).toBe('Today is Saturday.');

    // Verify betaResponsesSend was called with model set to models[0]
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    const sentRequest = mockBetaResponsesSend.mock.calls[0][1].responsesRequest;
    expect(sentRequest.model).toBe('mistralai/mistral-small-2603');
    expect(sentRequest.models).toEqual([
      'mistralai/mistral-small-2603',
      'mistralai/mistral-large-2512',
    ]);
    expect(sentRequest.tools).toEqual([
      {
        type: 'openrouter:datetime',
      },
    ]);
  });

  it('preserves explicit model when provided alongside models', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_2', 'primary-model', [
        {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'Hello',
              annotations: [],
            },
          ],
        },
      ]),
    });

    const result = callModel(client, {
      model: 'primary-model',
      models: [
        'fallback-model-1',
        'fallback-model-2',
      ],
      input: 'Hello',
      tools: [
        serverTool({
          type: 'openrouter:datetime',
        }),
      ],
    });

    await result.getText();

    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    const sentRequest = mockBetaResponsesSend.mock.calls[0][1].responsesRequest;
    expect(sentRequest.model).toBe('primary-model');
    expect(sentRequest.models).toEqual([
      'fallback-model-1',
      'fallback-model-2',
    ]);
  });

  it('populates model from models[0] when models is an async function', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_3', 'dynamic-model-1', [
        {
          id: 'msg_3',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'Dynamic model response',
              annotations: [],
            },
          ],
        },
      ]),
    });

    const result = callModel(client, {
      models: async () => [
        'dynamic-model-1',
        'dynamic-model-2',
      ],
      input: 'Test',
      tools: [
        serverTool({
          type: 'openrouter:datetime',
        }),
      ],
    });

    const text = await result.getText();
    expect(text).toBe('Dynamic model response');

    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    const sentRequest = mockBetaResponsesSend.mock.calls[0][1].responsesRequest;
    expect(sentRequest.model).toBe('dynamic-model-1');
    expect(sentRequest.models).toEqual([
      'dynamic-model-1',
      'dynamic-model-2',
    ]);
  });
});

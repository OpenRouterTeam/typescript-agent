import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { callModel } from '../../src/inner-loop/call-model.js';
import { HooksManager } from '../../src/lib/hooks-manager.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

function response(id: string, output: models.OutputItemsUnion[] = []): models.OpenResponsesResult {
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
  } as models.OpenResponsesResult;
}

const message: models.OutputMessage = {
  id: 'message',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [
    {
      type: 'output_text',
      text: 'hello',
      annotations: [],
    },
  ],
};

function completedStream(result: models.OpenResponsesResult): ReadableStream<models.StreamEvents> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({
        type: 'response.completed',
        response: result,
        sequenceNumber: 0,
      } as models.StreamEvents);
      controller.close();
    },
  });
}

function failedStream(): ReadableStream<models.StreamEvents> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({
        type: 'response.failed',
        response: response('failed'),
        sequenceNumber: 0,
      } as models.StreamEvents);
      controller.close();
    },
  });
}

function client(): OpenRouterCore {
  return {} as OpenRouterCore;
}

describe('ModelResult replay compaction', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('keeps the default full replay for sequential consumers', async () => {
    const result = response('full', [
      message,
    ]);
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: completedStream(result),
    });
    const modelResult = callModel(client(), {
      model: 'test-model',
      input: 'hello',
    });

    await expect(modelResult.getTextStream().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(modelResult.getResponse()).resolves.toEqual(result);
  });

  it('returns the terminal response after active-consumer replay trims history', async () => {
    const result = response('active', [
      message,
    ]);
    const hooks = new HooksManager();
    const postModelCalls: unknown[] = [];
    hooks.on('PostModelCall', {
      handler: (payload) => {
        postModelCalls.push(payload);
      },
    });
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: completedStream(result),
    });
    const modelResult = callModel(client(), {
      model: 'test-model',
      input: 'hello',
      streamReplay: 'active-consumers',
      hooks,
    });

    await expect(modelResult.getFullResponsesStream().next()).resolves.toMatchObject({
      value: {
        type: 'response.completed',
      },
    });
    await expect(modelResult.getResponse()).resolves.toEqual(result);
    expect(postModelCalls).toHaveLength(1);
  });

  it('omits streamReplay from the follow-up request body', async () => {
    const initial = response('tool', [
      {
        type: 'function_call',
        id: 'call-item',
        callId: 'call-id',
        name: 'echo',
        arguments: '{}',
        status: 'completed',
      },
    ]);
    const followUp = response('follow-up', [
      message,
    ]);
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: initial,
      })
      .mockResolvedValueOnce({
        ok: true,
        value: followUp,
      });

    const modelResult = callModel(client(), {
      model: 'test-model',
      input: 'hello',
      streamReplay: 'active-consumers',
      tools: [
        {
          type: 'function',
          function: {
            name: 'echo',
            description: 'Echo input.',
            inputSchema: z.object({}),
            outputSchema: z.string(),
            execute: async () => 'ok',
          },
        },
      ],
    });

    await expect(modelResult.getResponse()).resolves.toEqual(followUp);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    expect(mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest).not.toHaveProperty(
      'streamReplay',
    );
  });

  it('uses the cached terminal response when active replay released the buffer', async () => {
    const result = response('usage', [
      message,
    ]);
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: completedStream(result),
    });
    const modelResult = callModel(client(), {
      model: 'test-model',
      input: 'hello',
      streamReplay: 'active-consumers',
    });

    for await (const _event of modelResult.getFullResponsesStream()) {
      // Drain the consumer so active replay can release its terminal event.
    }
    await expect(modelResult.getUsage()).resolves.toMatchObject({
      modelCalls: 1,
    });
  });

  it('strips streamReplay from the resolved request', async () => {
    const result = response('request', [
      message,
    ]);
    const testClient = client();
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: completedStream(result),
    });
    const modelResult = callModel(testClient, {
      model: 'test-model',
      input: 'hello',
      streamReplay: 'active-consumers',
    });

    await modelResult.getResponse();
    expect(mockBetaResponsesSend).toHaveBeenCalledWith(
      testClient,
      expect.objectContaining({
        responsesRequest: expect.not.objectContaining({
          streamReplay: expect.anything(),
        }),
      }),
      expect.anything(),
    );
  });

  it('does not replace the provider terminal result when cleanup fails', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: failedStream(),
    });
    const modelResult = callModel(client(), {
      model: 'test-model',
      input: 'hello',
      streamReplay: 'active-consumers',
    });

    await expect(modelResult.getResponse()).rejects.toThrow();
  });
});

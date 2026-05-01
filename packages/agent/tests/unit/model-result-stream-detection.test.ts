import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { ModelResult } from '../../src/lib/model-result.js';

function makeResponse(): models.OpenResponsesResult {
  return {
    id: 'resp_test_stream_detection',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [
      {
        id: 'msg_test_stream_detection',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'ok',
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
  } as models.OpenResponsesResult;
}

function makeCompletedStream(
  response: models.OpenResponsesResult,
): ReadableStream<models.StreamEvents> {
  return new ReadableStream<models.StreamEvents>({
    start(controller) {
      controller.enqueue({
        type: 'response.completed',
        response,
        sequenceNumber: 0,
      } as models.StreamEvents);
      controller.close();
    },
  });
}

function makeResult(): ModelResult<[]> {
  return new ModelResult({
    request: {
      model: 'test-model',
      input: 'hello',
    },
    client: {} as OpenRouterCore,
    tools: [],
  });
}

describe('ModelResult stream detection', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('accepts ReadableStream responses whose constructor name is not EventStream', async () => {
    const response = makeResponse();
    const stream = makeCompletedStream(response);

    expect(Object.getPrototypeOf(stream)?.constructor?.name).not.toBe('EventStream');
    expect(stream).toBeInstanceOf(ReadableStream);

    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: stream,
    });

    await expect(makeResult().getResponse()).resolves.toEqual(response);
  });

  it('rejects toReadableStream-only adapters before ReusableReadableStream reads them', async () => {
    const response = makeResponse();
    const adapter = {
      toReadableStream: () => makeCompletedStream(response),
    };

    expect('getReader' in adapter).toBe(false);

    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: adapter,
    });

    await expect(makeResult().getResponse()).rejects.toThrow('Unexpected response type from API');
  });
});

import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { OpenResponsesResult } from '@openrouter/sdk/models/openresponsesresult';
import type { OpenResponsesStreamEvent } from '@openrouter/sdk/models/openresponsesstreamevent';
import { describe, expect, it, vi } from 'vitest';
import { ModelResult } from '../../src/lib/model-result.js';

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: vi.fn(),
}));

const { betaResponsesSend } = vi.mocked(await import('@openrouter/sdk/funcs/betaResponsesSend'));

function makeResponse(outputText: string): OpenResponsesResult {
  return {
    id: 'resp_test',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [],
    outputText,
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

function makeCompletedEvent(response: OpenResponsesResult): OpenResponsesStreamEvent {
  return {
    type: 'response.completed',
    response,
    sequenceNumber: 0,
  };
}

describe('ModelResult stream response detection', () => {
  it('should accept readable stream responses whose constructor name is not EventStream', async () => {
    const response = makeResponse('streamed response');
    const stream = new ReadableStream<OpenResponsesStreamEvent>({
      start(controller) {
        controller.enqueue(makeCompletedEvent(response));
        controller.close();
      },
    });

    betaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: stream,
    });

    const result = new ModelResult({
      request: {
        model: 'test-model',
        input: 'test',
      },
      client: {} as OpenRouterCore,
    });

    await expect(result.getText()).resolves.toBe('streamed response');
  });

  it('should reject objects that expose toReadableStream without readable stream behavior', async () => {
    betaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: {
        toReadableStream: () => new ReadableStream(),
      },
    });

    const result = new ModelResult({
      request: {
        model: 'test-model',
        input: 'test',
      },
      client: {} as OpenRouterCore,
    });

    await expect(result.getText()).rejects.toThrow('Unexpected response type from API');
  });
});

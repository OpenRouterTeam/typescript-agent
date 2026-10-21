import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';
import { tool } from '../../src/lib/tool.js';

function response(
  id: string,
  output: models.OpenResponsesResult['output'],
): models.OpenResponsesResult {
  return {
    id,
    object: 'response',
    createdAt: 1_783_462_506,
    completedAt: 1_783_462_520,
    model: 'test-model',
    status: 'completed',
    error: null,
    output,
    usage: {
      inputTokens: 10,
      inputTokensDetails: {
        cachedTokens: 0,
      },
      outputTokens: 10,
      totalTokens: 20,
      outputTokensDetails: {
        reasoningTokens: 0,
      },
    },
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: true,
  } as models.OpenResponsesResult;
}

/**
 * Two distinct `function_call` items (different item ids and arguments) whose
 * `call_id`s are given by the caller. With `['call_a', 'call_a']` this is the
 * malformed batch from issue #128.
 */
function recordCalls(
  responseId: string,
  callIds: [
    string,
    string,
  ],
): models.OpenResponsesResult {
  return response(
    responseId,
    callIds.map((callId, index) => ({
      type: 'function_call' as const,
      id: `${responseId}_item_${index}`,
      callId,
      name: 'record',
      arguments: JSON.stringify({
        message: index === 0 ? 'alpha' : 'beta',
      }),
      status: 'completed' as const,
    })),
  );
}

function textResponse(): models.OpenResponsesResult {
  return response('resp_text', [
    {
      id: 'msg_final',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'Done.',
          annotations: [],
        },
      ],
    },
  ]);
}

function followupOutputCallIds(requestIndex: number): string[] {
  const input = mockBetaResponsesSend.mock.calls[requestIndex]?.[1]?.responsesRequest?.input as
    | Array<{
        type?: string;
        callId?: string;
      }>
    | undefined;
  return (input ?? [])
    .filter((item) => item.type === 'function_call_output')
    .map((item) => item.callId ?? '');
}

const client = {} as OpenRouterCore;

describe('duplicate call ids in one response', () => {
  let executed: string[];
  let recordTool: ReturnType<typeof makeRecordTool>;

  function makeRecordTool() {
    return tool({
      name: 'record',
      inputSchema: z.object({
        message: z.string(),
      }),
      execute: async ({ message }) => {
        executed.push(message);
        return {
          ok: true,
        };
      },
    });
  }

  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
    executed = [];
    recordTool = makeRecordTool();
  });

  it('executes both calls and returns one output per call id when the ids are distinct', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: recordCalls('resp_calls', [
          'call_a',
          'call_b',
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse(),
      });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'Record alpha and beta.',
      tools: [
        recordTool,
      ] as const,
    }).getText();

    expect(text).toBe('Done.');
    expect(executed).toEqual([
      'alpha',
      'beta',
    ]);
    expect(followupOutputCallIds(1)).toEqual([
      'call_a',
      'call_b',
    ]);
  });

  it('rejects the batch before executing either call when two calls share an id', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: recordCalls('resp_calls', [
          'call_a',
          'call_a',
        ]),
      })
      .mockResolvedValue({
        ok: true,
        value: textResponse(),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Record alpha and beta.',
      tools: [
        recordTool,
      ] as const,
    });

    await expect(result.getText()).rejects.toThrow(/call_a/);
    expect(executed).toEqual([]);
    // No follow-up request carrying two outputs for `call_a`.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate-id batch that arrives on a later turn', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: recordCalls('resp_first', [
          'call_a',
          'call_b',
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: recordCalls('resp_second', [
          'call_c',
          'call_c',
        ]),
      })
      .mockResolvedValue({
        ok: true,
        value: textResponse(),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Record twice.',
      tools: [
        recordTool,
      ] as const,
    });

    await expect(result.getText()).rejects.toThrow(/call_c/);
    // Only the first, well-formed batch ran.
    expect(executed).toEqual([
      'alpha',
      'beta',
    ]);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('rejects a duplicate-id batch left pending when stopWhen ends the loop', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: recordCalls('resp_first', [
          'call_a',
          'call_b',
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: recordCalls('resp_second', [
          'call_c',
          'call_c',
        ]),
      })
      .mockResolvedValue({
        ok: true,
        value: textResponse(),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Record twice.',
      stopWhen: stepCountIs(1),
      tools: [
        recordTool,
      ] as const,
    });

    await expect(result.getText()).rejects.toThrow(/call_c/);
    expect(executed).toEqual([
      'alpha',
      'beta',
    ]);
    // No final text-coercion request either.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('leaves a duplicate-id batch of manual tools to the caller', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: recordCalls('resp_calls', [
        'call_a',
        'call_a',
      ]),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Record alpha and beta.',
      tools: [
        tool({
          name: 'record',
          inputSchema: z.object({
            message: z.string(),
          }),
          execute: false,
        }),
      ] as const,
    });

    // The SDK runs nothing for manual tools, so it surfaces both calls as
    // emitted and the caller decides how to correlate them.
    const toolCalls = await result.getToolCalls();
    expect(toolCalls.map((toolCall) => toolCall.id)).toEqual([
      'call_a',
      'call_a',
    ]);
    await expect(result.getResponse()).resolves.toMatchObject({
      id: 'resp_calls',
    });
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });
});

import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { ToolType } from '../../src/lib/tool-types.js';

function toolCallResponse(): models.OpenResponsesResult {
  return {
    id: 'resp_tool_call',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [
      {
        type: 'function_call',
        id: 'fc_1',
        callId: 'call_abc',
        name: 'post_comment',
        arguments: '{"body":"looks good"}',
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
  } as models.OpenResponsesResult;
}

function emptyOutputResponse(id = 'resp_empty'): models.OpenResponsesResult {
  return {
    id,
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [],
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

function textResponse(text: string, id = 'resp_text'): models.OpenResponsesResult {
  return {
    id,
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [
      {
        id: 'msg_text',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text,
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

const postCommentTool = {
  type: ToolType.Function,
  function: {
    name: 'post_comment',
    description: 'Post a comment.',
    inputSchema: z.object({
      body: z.string(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
    }),
    execute: async (_params: { body: string }) => ({
      ok: true,
    }),
  },
} as const;

const client = {} as OpenRouterCore;

describe('tool-terminal empty final response (PR-2)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('retries once then accepts empty final after a completed tool round', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: emptyOutputResponse('resp_empty_1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: emptyOutputResponse('resp_empty_2'),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Review and post a comment.',
      tools: [
        postCommentTool,
      ] as const,
    });

    const text = await result.getText();
    expect(text).toBe('');
    // initial + follow-up + one empty-output retry
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);

    const response = await result.getResponse();
    expect(response.id).toBe('resp_empty_2');
    expect(response.output).toEqual([]);
  });

  it('returns text when the empty-final retry succeeds', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: emptyOutputResponse('resp_empty'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('Done posting.', 'resp_retry_text'),
      });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'Review and post a comment.',
      tools: [
        postCommentTool,
      ] as const,
    }).getText();

    expect(text).toBe('Done posting.');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);
  });

  it('throws on empty final after tool rounds when strictFinalResponse is true', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: emptyOutputResponse(),
      });

    await expect(
      callModel(client, {
        model: 'test-model',
        input: 'Review and post a comment.',
        tools: [
          postCommentTool,
        ] as const,
        strictFinalResponse: true,
      }).getText(),
    ).rejects.toThrow('Invalid final response: empty or invalid output');

    // No retry when strict
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('still throws on empty output when no tool rounds completed', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: emptyOutputResponse(),
    });

    await expect(
      callModel(client, {
        model: 'test-model',
        input: 'Hello',
      }).getText(),
    ).rejects.toThrow('Invalid final response: empty or invalid output');

    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });
});

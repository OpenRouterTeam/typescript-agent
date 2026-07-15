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

  it('strips tools from the empty-final retry so it cannot emit an unexecuted tool call', async () => {
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
    // The natural-loop follow-up request still carries tools…
    const followupRequest = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    expect(followupRequest).toHaveProperty('tools');
    // …but the retry must not, so it coerces a text turn instead of a
    // fresh function_call that would be silently dropped.
    const retryRequest = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest;
    expect(retryRequest).not.toHaveProperty('tools');
    expect(retryRequest).not.toHaveProperty('toolChoice');
    expect(retryRequest).not.toHaveProperty('parallelToolCalls');
    expect(retryRequest.input).toEqual(followupRequest.input);
  });

  it('retries the same no-tools request when allowFinalResponse returns empty', async () => {
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
      stopWhen: stepCountIs(0),
      allowFinalResponse: 'Summarize the result.',
    }).getText();

    expect(text).toBe('Done posting.');
    const finalRequest = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    const retryRequest = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest;
    expect(retryRequest).toEqual(finalRequest);
    expect(retryRequest).not.toHaveProperty('tools');
    expect(retryRequest.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          callId: 'call_abc',
        }),
        expect.objectContaining({
          role: 'user',
          content: 'Summarize the result.',
        }),
      ]),
    );
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

  it('persists the successful empty-final retry response to conversation state', async () => {
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

    let stored: unknown = null;
    const result = callModel(client, {
      model: 'test-model',
      input: 'Review and post a comment.',
      tools: [
        postCommentTool,
      ] as const,
      state: {
        load: async () => stored as never,
        save: async (s: unknown) => {
          stored = s;
        },
      },
    });

    const text = await result.getText();
    expect(text).toBe('Done posting.');

    // The retried final turn must be recorded in state — the assistant
    // message from resp_retry_text must appear in messages.
    const messages = (
      stored as {
        messages: Array<{
          type?: string;
          role?: string;
        }>;
      }
    ).messages;
    const assistantMessages = messages.filter(
      (m) => m.type === 'message' && m.role === 'assistant',
    );
    expect(assistantMessages.length).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).toContain('Done posting.');
  });

  it('does not send strictFinalResponse (or other client-only fields) to the API', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Hi.', 'resp_text'),
    });

    await callModel(client, {
      model: 'test-model',
      input: 'Hello',
      strictFinalResponse: true,
      allowFinalResponse: true,
    }).getText();

    const request = mockBetaResponsesSend.mock.calls[0]?.[1]?.responsesRequest as Record<
      string,
      unknown
    >;
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty('strictFinalResponse');
    expect(request).not.toHaveProperty('allowFinalResponse');
    expect(request).not.toHaveProperty('stopWhen');
    expect(request).not.toHaveProperty('sharedContextSchema');
    expect(request).not.toHaveProperty('onTurnStart');
    expect(request).not.toHaveProperty('onTurnEnd');
  });
});

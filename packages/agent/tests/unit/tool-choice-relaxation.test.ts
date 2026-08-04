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

function toolCallResponse(id: string, callId: string): models.OpenResponsesResult {
  return {
    id,
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [
      {
        type: 'function_call',
        id: `fc_${callId}`,
        callId,
        name: 'get_weather',
        arguments: '{"location":"Tokyo"}',
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

function textResponse(text: string): models.OpenResponsesResult {
  return {
    id: 'resp_text',
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

const weatherTool = {
  type: ToolType.Function,
  function: {
    name: 'get_weather',
    description: 'Get the weather for a location.',
    inputSchema: z.object({
      location: z.string(),
    }),
    outputSchema: z.object({
      temperature: z.number(),
    }),
    execute: async (_params: { location: string }) => ({
      temperature: 22,
    }),
  },
} as const;

const client = {} as OpenRouterCore;

function requestOfCall(index: number): models.ResponsesRequest {
  const request = mockBetaResponsesSend.mock.calls[index]?.[1]?.responsesRequest;
  expect(request).toBeDefined();
  return request as models.ResponsesRequest;
}

/**
 * DEV-785: a forced tool choice must apply to the initial model turn only.
 * Reapplying it on every follow-up turn forbids the model from ever
 * answering in text, looping it through tool calls until the step budget
 * runs out.
 */
describe('forced tool choice relaxation on follow-up turns', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it("relaxes toolChoice:'required' to 'auto' after a successful tool round", async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('resp_1', 'call_1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('It is 22 degrees.'),
      });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      toolChoice: 'required',
      stopWhen: stepCountIs(5),
    }).getText();

    expect(text).toBe('It is 22 degrees.');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);

    // Initial turn: the caller's forced choice reaches the wire intact.
    expect(requestOfCall(0).toolChoice).toBe('required');

    // Follow-up turn: relaxed to 'auto', with tools still available so the
    // model may call another tool OR answer in text.
    const followUp = requestOfCall(1);
    expect(followUp.toolChoice).toBe('auto');
    expect(followUp.tools).toBeDefined();
  });

  it('relaxes a forced specific-tool choice after a successful tool round', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('resp_1', 'call_1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('Done.'),
      });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      toolChoice: {
        type: 'function',
        name: 'get_weather',
      },
      stopWhen: stepCountIs(5),
    }).getText();

    expect(text).toBe('Done.');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    expect(requestOfCall(0).toolChoice).toEqual({
      type: 'function',
      name: 'get_weather',
    });
    expect(requestOfCall(1).toolChoice).toBe('auto');
  });

  it("relaxes allowed_tools mode:'required' to mode:'auto' keeping the tool set", async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('resp_1', 'call_1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('Done.'),
      });

    const allowedTools = [
      {
        type: 'function',
        name: 'get_weather',
      },
    ];

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      toolChoice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: allowedTools,
      },
      stopWhen: stepCountIs(5),
    }).getText();

    expect(text).toBe('Done.');
    expect(requestOfCall(1).toolChoice).toEqual({
      type: 'allowed_tools',
      mode: 'auto',
      tools: allowedTools,
    });
  });

  it("keeps toolChoice:'auto' unchanged on follow-up turns", async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('resp_1', 'call_1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('Done.'),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      toolChoice: 'auto',
      stopWhen: stepCountIs(5),
    }).getText();

    expect(requestOfCall(1).toolChoice).toBe('auto');
  });

  it('still forces the final no-tools turn when the budget is genuinely exhausted', async () => {
    // The relaxed 'auto' follow-up returns another tool call, and
    // stepCountIs(1) halts the loop there — the run must still end via the
    // forced final-response turn (toolChoice 'none'), not hang or loop.
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('resp_1', 'call_1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('resp_2', 'call_2'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('Final summary.'),
      });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      allowFinalResponse: true,
    }).getText();

    expect(text).toBe('Final summary.');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);
    expect(requestOfCall(1).toolChoice).toBe('auto');
    expect(requestOfCall(2).toolChoice).toBe('none');
  });
});

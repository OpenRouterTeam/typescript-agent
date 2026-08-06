import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { canonicalizeKeyMaterial } from '../../src/lib/doom-loop.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';
import type { ConversationState, StateAccessor } from '../../src/lib/tool-types.js';
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

function createMemoryAccessor(): {
  accessor: StateAccessor;
  get: () => ConversationState | null;
} {
  let stored: ConversationState | null = null;
  return {
    accessor: {
      load: async () => stored,
      save: async (state) => {
        stored = state;
      },
    },
    get: () => stored,
  };
}

/**
 * DEV-785: a concrete forced tool choice is one-shot until its resolved
 * semantic value changes. Reapplying an unchanged choice on every follow-up
 * forbids the model from ever answering in text, while suppressing a newly
 * resolved dynamic choice prevents callers from intentionally forcing a
 * later turn.
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

  it('keeps an unchanged consumed choice relaxed across multiple follow-up turns', async () => {
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
      stopWhen: stepCountIs(5),
    }).getText();

    expect(text).toBe('Final summary.');
    expect(requestOfCall(0).toolChoice).toBe('required');
    expect(requestOfCall(1).toolChoice).toBe('auto');
    expect(requestOfCall(2).toolChoice).toBe('auto');
  });

  it('re-arms when a dynamic forced choice resolves to a different semantic value', async () => {
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
        value: textResponse('Done.'),
      });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      toolChoice: (context) =>
        context.numberOfTurns === 0
          ? 'required'
          : {
              type: 'function',
              name: 'get_weather',
            },
      stopWhen: stepCountIs(5),
    }).getText();

    expect(text).toBe('Done.');
    expect(requestOfCall(0).toolChoice).toBe('required');
    expect(requestOfCall(1).toolChoice).toEqual({
      type: 'function',
      name: 'get_weather',
    });
    expect(requestOfCall(2).toolChoice).toBe('auto');
  });

  it('re-arms the same dynamic forced choice after an unforced turn', async () => {
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
        value: toolCallResponse('resp_3', 'call_3'),
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
      toolChoice: (context) => (context.numberOfTurns === 1 ? 'auto' : 'required'),
      stopWhen: stepCountIs(5),
    }).getText();

    expect(text).toBe('Done.');
    expect(requestOfCall(0).toolChoice).toBe('required');
    expect(requestOfCall(1).toolChoice).toBe('auto');
    expect(requestOfCall(2).toolChoice).toBe('required');
    expect(requestOfCall(3).toolChoice).toBe('auto');
  });

  it('persists satisfaction across approval resume and resets it after completion', async () => {
    const approvalWeatherTool = {
      ...weatherTool,
      function: {
        ...weatherTool.function,
        requireApproval: true,
      },
    } as const;
    const { accessor, get } = createMemoryAccessor();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: toolCallResponse('resp_1', 'call_1'),
    });

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        approvalWeatherTool,
      ] as const,
      toolChoice: 'required',
      state: accessor,
    }).getResponse();

    expect(requestOfCall(0).toolChoice).toBe('required');
    expect(get()?.status).toBe('awaiting_approval');
    expect(get()?.consumedForcedToolChoiceKey).toBe(canonicalizeKeyMaterial('required'));

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('It is 22 degrees.'),
    });

    const resumedText = await callModel(client, {
      model: 'test-model',
      input: [],
      tools: [
        approvalWeatherTool,
      ] as const,
      toolChoice: 'required',
      state: accessor,
      approveToolCalls: [
        'call_1',
      ],
    }).getText();

    expect(resumedText).toBe('It is 22 degrees.');
    expect(requestOfCall(1).toolChoice).toBe('auto');
    expect(get()?.status).toBe('complete');
    expect(get()?.consumedForcedToolChoiceKey).toBeUndefined();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: toolCallResponse('resp_2', 'call_2'),
    });

    await callModel(client, {
      model: 'test-model',
      input: 'Start a new weather request.',
      tools: [
        approvalWeatherTool,
      ] as const,
      toolChoice: 'required',
      state: accessor,
    }).getResponse();

    expect(requestOfCall(2).toolChoice).toBe('required');
  });

  it('clears consumed choice state when an interrupted run becomes a fresh request', async () => {
    const approvalWeatherTool = {
      ...weatherTool,
      function: {
        ...weatherTool.function,
        requireApproval: true,
      },
    } as const;
    let stored: ConversationState | null = null;
    let loadCount = 0;
    const accessor: StateAccessor = {
      load: async () => {
        loadCount++;
        if (loadCount === 2 && stored) {
          return {
            ...stored,
            interruptedBy: 'user',
          };
        }
        return stored;
      },
      save: async (state) => {
        stored = state;
      },
    };

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: toolCallResponse('resp_1', 'call_1'),
    });

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      toolChoice: 'required',
      state: accessor,
    }).getResponse();

    expect(stored?.status).toBe('interrupted');
    expect(stored?.consumedForcedToolChoiceKey).toBeUndefined();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: toolCallResponse('resp_2', 'call_2'),
    });

    await callModel(client, {
      model: 'test-model',
      input: 'Start a fresh weather request.',
      tools: [
        approvalWeatherTool,
      ] as const,
      toolChoice: 'required',
      state: accessor,
    }).getResponse();

    expect(requestOfCall(1).toolChoice).toBe('required');
  });

  it('relaxes the first model request after a manual client-tool resume', async () => {
    const manualWeatherTool = {
      ...weatherTool,
      function: {
        ...weatherTool.function,
        execute: false,
      },
    } as const;
    const { accessor, get } = createMemoryAccessor();

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('resp_1', 'call_1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('It is 22 degrees.'),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        manualWeatherTool,
      ] as const,
      toolChoice: 'required',
      state: accessor,
    }).getResponse();

    expect(get()?.status).toBe('awaiting_client_tools');
    expect(get()?.consumedForcedToolChoiceKey).toBe(canonicalizeKeyMaterial('required'));

    const resumedText = await callModel(client, {
      model: 'test-model',
      input: [
        {
          type: 'function_call_output',
          callId: 'call_1',
          output: JSON.stringify({
            temperature: 22,
          }),
        },
      ],
      tools: [
        manualWeatherTool,
      ] as const,
      toolChoice: 'required',
      state: accessor,
    }).getText();

    expect(resumedText).toBe('It is 22 degrees.');
    expect(requestOfCall(1).toolChoice).toBe('auto');
  });
});

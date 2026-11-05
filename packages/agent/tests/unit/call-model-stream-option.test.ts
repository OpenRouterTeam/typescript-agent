/**
 * `callModel({ stream })` through the real loop, with betaResponsesSend mocked
 * at the module level.
 *
 * Every assertion is on the DISPATCHED request: the engine has five send
 * sites (initial, tool-round follow-up, final, empty-output retry, resume),
 * and each one used to hardcode `stream: true`. A test per site keeps a new
 * or refactored site from silently re-forcing streaming.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';
import { tool } from '../../src/lib/tool.js';
import type { ConversationState, StateAccessor, Tool } from '../../src/lib/tool-types.js';

afterEach(() => {
  mockBetaResponsesSend.mockReset();
  vi.restoreAllMocks();
});

const client = {} as unknown as OpenRouterCore;

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

function toolCallResponse(): models.OpenResponsesResult {
  return makeResponse('resp_tool', [
    {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call_1',
      name: 'get_weather',
      arguments: '{"location":"Tokyo"}',
      status: 'completed',
    },
  ]);
}

function textResponse(text: string): models.OpenResponsesResult {
  return makeResponse('resp_text', [
    {
      id: 'msg_1',
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
  ]);
}

function mockResponses(...responses: models.OpenResponsesResult[]): void {
  for (const value of responses) {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value,
    });
  }
}

/** The `stream` flag on each request actually handed to the SDK. */
function dispatchedStreamFlags(): unknown[] {
  return mockBetaResponsesSend.mock.calls.map(
    (call) =>
      (
        call[1] as {
          responsesRequest: models.ResponsesRequest;
        }
      ).responsesRequest.stream,
  );
}

function makeWeatherTool(options?: { requireApproval?: boolean }) {
  return tool({
    name: 'get_weather',
    inputSchema: z.object({
      location: z.string(),
    }),
    outputSchema: z.object({
      temperature: z.number(),
    }),
    ...(options?.requireApproval && {
      requireApproval: true,
    }),
    execute: async () => ({
      temperature: 22,
    }),
  });
}

function createMemoryAccessor<TTools extends readonly Tool[]>(): StateAccessor<TTools> {
  let state: ConversationState<TTools> | null = null;
  return {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
  };
}

describe('callModel stream option', () => {
  it('streams every request by default', async () => {
    mockResponses(toolCallResponse(), textResponse('Sunny.'));

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        makeWeatherTool(),
      ] as const,
    }).getText();

    expect(dispatchedStreamFlags()).toEqual([
      true,
      true,
    ]);
  });

  it('streams every request when stream is true', async () => {
    mockResponses(textResponse('Sunny.'));

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      stream: true,
    }).getText();

    expect(dispatchedStreamFlags()).toEqual([
      true,
    ]);
  });

  it('sends the initial request and tool-round follow-ups non-streaming', async () => {
    mockResponses(toolCallResponse(), toolCallResponse(), textResponse('Sunny.'));

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        makeWeatherTool(),
      ] as const,
      stream: false,
    }).getText();

    expect(text).toBe('Sunny.');
    expect(dispatchedStreamFlags()).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('sends a no-tools request non-streaming', async () => {
    mockResponses(textResponse('Hello.'));

    const result = callModel(client, {
      model: 'test-model',
      input: 'Hi',
      stream: false,
    });

    expect(await result.getText()).toBe('Hello.');
    expect((await result.getResponse()).id).toBe('resp_text');
    expect(dispatchedStreamFlags()).toEqual([
      false,
    ]);
  });

  it('keeps stream false when request fields are resolved per turn', async () => {
    mockResponses(toolCallResponse(), textResponse('Sunny.'));

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      temperature: () => 0.2,
      tools: [
        makeWeatherTool(),
      ] as const,
      stream: false,
    }).getText();

    expect(dispatchedStreamFlags()).toEqual([
      false,
      false,
    ]);
  });

  it('sends the allowFinalResponse final turn non-streaming', async () => {
    mockResponses(toolCallResponse(), textResponse('Final summary.'));

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        makeWeatherTool(),
      ] as const,
      stopWhen: stepCountIs(0),
      allowFinalResponse: true,
      stream: false,
    }).getText();

    expect(text).toBe('Final summary.');
    expect(dispatchedStreamFlags()).toEqual([
      false,
      false,
    ]);
  });

  it('sends the empty-final-output retry non-streaming', async () => {
    mockResponses(toolCallResponse(), makeResponse('resp_empty', []), textResponse('Sunny.'));

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        makeWeatherTool(),
      ] as const,
      stream: false,
    }).getText();

    expect(text).toBe('Sunny.');
    expect(dispatchedStreamFlags()).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('sends the post-approval resume request non-streaming', async () => {
    const tools = [
      makeWeatherTool({
        requireApproval: true,
      }),
    ] as const;
    const state = createMemoryAccessor<typeof tools>();

    mockResponses(toolCallResponse());
    const paused = callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools,
      state,
      stream: false,
    });
    await paused.getResponse();
    expect(await paused.requiresApproval()).toBe(true);

    mockResponses(textResponse('Sunny.'));
    const resumed = callModel(client, {
      model: 'test-model',
      input: [],
      tools,
      state,
      approveToolCalls: [
        'call_1',
      ],
      stream: false,
    });

    expect(await resumed.getText()).toBe('Sunny.');
    expect(dispatchedStreamFlags()).toEqual([
      false,
      false,
    ]);
  });
});

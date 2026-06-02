import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { ConversationState, StateAccessor } from '../../src/index.js';
import { callModel } from '../../src/inner-loop/call-model.js';
import { ToolType } from '../../src/lib/tool-types.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

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

function toolCallResponse(callId: string, name: string, args: string): models.OpenResponsesResult {
  return {
    id: `resp_tc_${callId}`,
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
        name,
        arguments: args,
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

const echoTool = {
  type: ToolType.Function,
  function: {
    name: 'echo',
    description: 'Echo input',
    inputSchema: z.object({
      message: z.string(),
    }),
    execute: async (params: { message: string }) => ({
      echoed: params.message,
    }),
  },
} as const;

const client = {} as OpenRouterCore;

describe('User Input Persistence to State', () => {
  let storedState: ConversationState | null;
  let stateAccessor: StateAccessor;

  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
    storedState = null;
    stateAccessor = {
      load: async () => storedState,
      save: async (state) => {
        storedState = state;
      },
    };
  });

  it('should persist array user input items to state.messages after successful API call', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Hello back!'),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      state: stateAccessor,
    });

    await result.getText();

    expect(storedState).not.toBeNull();
    const messages = storedState!.messages as Array<{
      role?: string;
      content?: string;
    }>;
    expect(Array.isArray(messages)).toBe(true);

    const userItems = messages.filter((m) => m.role === 'user');
    expect(userItems.length).toBe(1);
    expect(userItems[0]!.content).toBe('Hello');
  });

  it('should persist string input normalized as user message', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Response'),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Hello string input',
      state: stateAccessor,
    });

    await result.getText();

    expect(storedState).not.toBeNull();
    const messages = storedState!.messages as Array<{
      role?: string;
      content?: string;
    }>;
    expect(Array.isArray(messages)).toBe(true);

    const userItems = messages.filter((m) => m.role === 'user');
    expect(userItems.length).toBe(1);
    expect(userItems[0]!.content).toBe('Hello string input');
  });

  it('should persist user input alongside tool results after tool execution', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('call_1', 'echo', '{"message":"hi"}'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('Done echoing.'),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Echo hi',
        },
      ],
      tools: [
        echoTool,
      ] as const,
      state: stateAccessor,
    });

    await result.getText();

    expect(storedState).not.toBeNull();
    const messages = storedState!.messages as Array<{
      role?: string;
      type?: string;
    }>;
    expect(Array.isArray(messages)).toBe(true);

    const userItems = messages.filter((m) => m.role === 'user');
    const fnCalls = messages.filter((m) => m.type === 'function_call');
    const fnOutputs = messages.filter((m) => m.type === 'function_call_output');

    expect(userItems.length).toBe(1);
    expect(fnCalls.length).toBe(1);
    expect(fnOutputs.length).toBe(1);
  });

  it('should include prior user input in API request when resuming from state', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('First response'),
    });

    const result1 = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'First message',
        },
      ],
      state: stateAccessor,
    });
    await result1.getText();

    const messagesAfterFirst = storedState!.messages as Array<{
      role?: string;
    }>;
    const firstUserItems = messagesAfterFirst.filter((m) => m.role === 'user');
    expect(firstUserItems.length).toBe(1);

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Second response'),
    });

    const result2 = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Second message',
        },
      ],
      state: stateAccessor,
    });
    await result2.getText();

    const secondCallRequest = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    expect(secondCallRequest).toBeDefined();

    const input = secondCallRequest.input as Array<{
      role?: string;
      content?: string;
    }>;
    expect(Array.isArray(input)).toBe(true);

    const userMessages = input.filter((i) => i.role === 'user');
    expect(userMessages.length).toBe(2);
    expect(userMessages[0]!.content).toBe('First message');
    expect(userMessages[1]!.content).toBe('Second message');
  });

  it('should accumulate user input from both calls in state after two callModel invocations', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Reply 1'),
    });

    const result1 = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Question 1',
        },
      ],
      state: stateAccessor,
    });
    await result1.getText();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Reply 2'),
    });

    const result2 = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Question 2',
        },
      ],
      state: stateAccessor,
    });
    await result2.getText();

    const messages = storedState!.messages as Array<{
      role?: string;
      content?: string;
    }>;
    const userItems = messages.filter((m) => m.role === 'user');
    expect(userItems.length).toBe(2);
    expect(userItems[0]!.content).toBe('Question 1');
    expect(userItems[1]!.content).toBe('Question 2');
  });

  it('should not persist user input when stream fails mid-read (ok:true + stream error)', async () => {
    const failingStream = new ReadableStream({
      start(controller) {
        controller.error(new Error('stream dropped'));
      },
    });

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: failingStream,
    });

    const result1 = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      state: stateAccessor,
    });

    await expect(result1.getText()).rejects.toThrow();

    const messagesAfterStreamFailure = storedState?.messages as
      | Array<{
          role?: string;
        }>
      | undefined;
    const userItemsAfterFailure =
      messagesAfterStreamFailure?.filter((m) => m.role === 'user') ?? [];
    expect(userItemsAfterFailure.length).toBe(0);

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Hello back!'),
    });

    const result2 = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      state: stateAccessor,
    });

    await result2.getText();

    const messages = storedState!.messages as Array<{
      role?: string;
      type?: string;
      content?: string;
    }>;
    const userItems = messages.filter((m) => m.role === 'user');
    expect(userItems.length).toBe(1);
    expect(userItems[0]!.content).toBe('Hello');

    const assistantItems = messages.filter((m) => m.role === 'assistant' || m.type === 'message');
    expect(assistantItems.length).toBe(1);
  });

  it('should not duplicate user input in state when retrying after API failure', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: false,
      error: new Error('API failure'),
    });

    const result1 = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      state: stateAccessor,
    });

    await expect(result1.getText()).rejects.toThrow();

    const messagesAfterFailure = storedState?.messages as
      | Array<{
          role?: string;
        }>
      | undefined;
    const userItemsAfterFailure = messagesAfterFailure?.filter((m) => m.role === 'user') ?? [];
    expect(userItemsAfterFailure.length).toBe(0);

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Hello back!'),
    });

    const result2 = callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      state: stateAccessor,
    });

    await result2.getText();

    const messages = storedState!.messages as Array<{
      role?: string;
      content?: string;
    }>;
    const userItems = messages.filter((m) => m.role === 'user');
    expect(userItems.length).toBe(1);
    expect(userItems[0]!.content).toBe('Hello');
  });
});

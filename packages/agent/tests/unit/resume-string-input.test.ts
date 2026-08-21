import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationState, StateAccessor } from '../../src/index.js';
import { callModel } from '../../src/inner-loop/call-model.js';

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

const client = {} as OpenRouterCore;

describe('Resume with string input (history + fresh string)', () => {
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

  it('normalizes a bare string input into a message item when resuming loaded history', async () => {
    // Turn 1: establish history in state.
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('First answer.'),
    });

    const result1 = callModel(client, {
      model: 'test-model',
      input: 'First question',
      state: stateAccessor,
    });
    await result1.getText();

    expect(storedState).not.toBeNull();
    expect((storedState!.messages as unknown[]).length).toBeGreaterThan(0);

    // Turn 2: resume the same state with a BARE STRING input. Before the fix,
    // the raw string was appended to the request input array un-normalized,
    // producing an invalid request (OpenResponses 400).
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Second answer.'),
    });

    const result2 = callModel(client, {
      model: 'test-model',
      input: 'Follow-up question',
      state: stateAccessor,
    });
    await result2.getText();

    // Inspect the actual request sent on turn 2.
    const request = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest as {
      input: unknown;
    };
    expect(Array.isArray(request.input)).toBe(true);
    const inputItems = request.input as unknown[];

    // No raw strings anywhere in the request input array.
    for (const item of inputItems) {
      expect(typeof item).not.toBe('string');
    }

    // The final item is the normalized fresh user message.
    const last = inputItems[inputItems.length - 1] as {
      role?: string;
      content?: string;
    };
    expect(last.role).toBe('user');
    expect(last.content).toBe('Follow-up question');
  });

  it('still accepts array input when resuming loaded history', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('First answer.'),
    });
    await callModel(client, {
      model: 'test-model',
      input: 'First question',
      state: stateAccessor,
    }).getText();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('Second answer.'),
    });
    await callModel(client, {
      model: 'test-model',
      input: [
        {
          role: 'user',
          content: 'Follow-up question',
        },
      ],
      state: stateAccessor,
    }).getText();

    const request = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest as {
      input: unknown[];
    };
    const last = request.input[request.input.length - 1] as {
      role?: string;
      content?: string;
    };
    expect(last.role).toBe('user');
    expect(last.content).toBe('Follow-up question');
  });
});

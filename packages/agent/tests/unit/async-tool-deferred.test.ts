import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { ConversationState, StateAccessor } from '../../src/index.js';
import { callModel } from '../../src/inner-loop/call-model.js';
import {
  resumeToolResults,
  ToolTaskAlreadySettledError,
} from '../../src/inner-loop/resume-tool-results.js';
import { tool } from '../../src/lib/tool.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

function functionCallItem(
  callId: string,
  name: string,
  args: string,
): models.OutputFunctionCallItem {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    callId,
    name,
    arguments: args,
    status: 'completed',
  };
}

function messageItem(id: string, text: string) {
  return {
    id,
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [
      {
        type: 'output_text' as const,
        text,
        annotations: [],
      },
    ],
  };
}

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
  } as models.OpenResponsesResult;
}

const client = {
  _options: {},
} as OpenRouterCore;

function createMemoryAccessor(): {
  accessor: StateAccessor;
  get: () => ConversationState | null;
} {
  let stored: ConversationState | null = null;
  const accessor: StateAccessor = {
    load: async () => stored,
    save: async (state) => {
      stored = state;
    },
  };
  return {
    accessor,
    get: () => stored,
  };
}

const legalReview = tool({
  name: 'request_legal_review',
  lifecycle: 'deferred',
  inputSchema: z.object({
    contractId: z.string(),
  }),
  outputSchema: z.object({
    approved: z.boolean(),
    notes: z.string().optional(),
  }),
  ack: 'Legal review requested.',
  run: async ({ contractId }, ctx) => {
    if (contractId === 'trivial') {
      return {
        approved: true,
      };
    }
    if (!ctx) {
      throw new Error('run context missing');
    }
    return ctx.defer(`ticket_${contractId}`);
  },
});

describe('tool.deferred — pause & placeholder', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('run returning ctx.defer() emits a placeholder, pauses with awaiting_async_tools, no follow-up request', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        functionCallItem('call_d1', 'request_legal_review', '{"contractId":"c-9"}'),
      ]),
    });

    const { accessor, get } = createMemoryAccessor();

    const result = callModel(client, {
      model: 'test-model',
      input: 'review contract c-9',
      tools: [
        legalReview,
      ] as const,
      state: accessor,
    });

    const state = await result.getState();
    expect(state.status).toBe('awaiting_async_tools');
    expect(state.pendingAsyncTools).toHaveLength(1);
    expect(state.pendingAsyncTools?.[0]).toMatchObject({
      callId: 'call_d1',
      taskId: 'ticket_c-9',
      name: 'request_legal_review',
      mode: 'defer',
      status: 'working',
    });

    // No follow-up request — the loop paused after the placeholder.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    // The placeholder output IS persisted (the round is fully paired).
    const messages = get()?.messages as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const placeholder = messages.find(
      (m) => m.type === 'function_call_output' && m.callId === 'call_d1',
    );
    expect(placeholder).toBeDefined();
    expect(placeholder?.output).toContain('"status":"pending"');
    expect(placeholder?.output).toContain('ticket_c-9');
    expect(placeholder?.output).toContain('Legal review requested.');
    // Check-ins are on by default: the note points at the task tool.
    expect(placeholder?.output).toContain('To check progress');
    expect(placeholder?.output).toContain('call the task tool');

    expect(await result.requiresApproval()).toBe(true);
  });

  it('run returning a plain value resolves synchronously like a regular tool', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_d2', 'request_legal_review', '{"contractId":"trivial"}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'approved!'),
        ]),
      });

    const { accessor } = createMemoryAccessor();
    const result = callModel(client, {
      model: 'test-model',
      input: 'review trivial contract',
      tools: [
        legalReview,
      ] as const,
      state: accessor,
    });

    const response = await result.getResponse();
    expect(response.id).toBe('resp_2');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);

    const followupInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as
      | Array<{
          type?: string;
          callId?: string;
          output?: string;
        }>
      | undefined;
    const output = followupInput?.find(
      (item) => item.type === 'function_call_output' && item.callId === 'call_d2',
    );
    expect(output?.output).toContain('"approved":true');

    const state = await result.getState();
    expect(state.status).toBe('complete');
    expect(state.pendingAsyncTools ?? []).toHaveLength(0);
  });

  it('run throwing yields an error output; the loop continues', async () => {
    const failing = tool({
      name: 'failing_start',
      lifecycle: 'deferred',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      run: async () => {
        throw new Error('external system down');
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_f1', 'failing_start', '{}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'could not start'),
        ]),
      });

    const response = await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        failing,
      ] as const,
    }).getResponse();

    expect(response.id).toBe('resp_2');
    const followupInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as
      | Array<{
          type?: string;
          callId?: string;
          output?: string;
        }>
      | undefined;
    const output = followupInput?.find(
      (item) => item.type === 'function_call_output' && item.callId === 'call_f1',
    );
    expect(output?.output).toContain('external system down');
  });
});

describe('tool.deferred — cross-process resume', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  async function pauseConversation(): Promise<{
    accessor: StateAccessor;
    get: () => ConversationState | null;
  }> {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        functionCallItem('call_d1', 'request_legal_review', '{"contractId":"c-9"}'),
      ]),
    });
    const { accessor, get } = createMemoryAccessor();
    await callModel(client, {
      model: 'test-model',
      input: 'review contract c-9',
      tools: [
        legalReview,
      ] as const,
      state: accessor,
    }).getState();
    mockBetaResponsesSend.mockReset();
    return {
      accessor,
      get,
    };
  }

  it('.resolve() without run config records the envelope and leaves state resumable', async () => {
    const { accessor, get } = await pauseConversation();

    const result = await legalReview.resolve(client, {
      state: accessor,
      taskId: 'ticket_c-9',
      output: {
        approved: true,
        notes: 'LGTM',
      },
    });

    expect(result).toBeNull();
    expect(mockBetaResponsesSend).not.toHaveBeenCalled();

    const state = get();
    expect(state?.status).toBe('in_progress');
    expect(state?.settledAsyncCallIds).toEqual([
      'call_d1',
    ]);
    // Settled entries stay with a terminal status (replay guard).
    expect(state?.pendingAsyncTools?.[0]?.status).toBe('completed');

    // The envelope is a USER message, not a second function_call_output.
    const messages = state?.messages as Array<{
      type?: string;
      role?: string;
      content?: string;
      callId?: string;
    }>;
    const envelope = messages.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope).toBeDefined();
    expect(envelope?.content).toContain('"taskId":"ticket_c-9"');
    expect(envelope?.content).toContain('"approved":true');
    const outputsForCall = messages.filter(
      (m) => m.type === 'function_call_output' && m.callId === 'call_d1',
    );
    expect(outputsForCall).toHaveLength(1); // only the placeholder
  });

  it('.resolve() with run config continues the conversation immediately', async () => {
    const { accessor } = await pauseConversation();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_2', [
        messageItem('msg_1', 'The contract was approved.'),
      ]),
    });

    const result = await legalReview.resolve(client, {
      state: accessor,
      taskId: 'ticket_c-9',
      output: {
        approved: true,
      },
      run: {
        model: 'test-model',
      },
    });

    expect(result).not.toBeNull();
    const text = await result?.getText();
    expect(text).toBe('The contract was approved.');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    // The dispatched request input carries the envelope after the placeholder.
    const input = mockBetaResponsesSend.mock.calls[0]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      role?: string;
      content?: string;
    }>;
    const envelopeIdx = input.findIndex(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    const placeholderIdx = input.findIndex((m) => m.type === 'function_call_output');
    expect(envelopeIdx).toBeGreaterThan(placeholderIdx);
  });

  it('output is validated against outputSchema before anything is persisted', async () => {
    const { accessor, get } = await pauseConversation();
    const before = JSON.stringify(get());

    await expect(
      legalReview.resolve(client, {
        state: accessor,
        taskId: 'ticket_c-9',
        // @ts-expect-error — deliberately invalid payload
        output: {
          approved: 'yes',
        },
      }),
    ).rejects.toThrow();

    expect(JSON.stringify(get())).toBe(before);
  });

  it('double resolve throws ToolTaskAlreadySettledError; ifSettled ignore no-ops', async () => {
    const { accessor } = await pauseConversation();

    await legalReview.resolve(client, {
      state: accessor,
      taskId: 'ticket_c-9',
      output: {
        approved: true,
      },
    });

    await expect(
      legalReview.resolve(client, {
        state: accessor,
        taskId: 'ticket_c-9',
        output: {
          approved: false,
        },
      }),
    ).rejects.toThrow(ToolTaskAlreadySettledError);

    const ignored = await legalReview.resolve(client, {
      state: accessor,
      taskId: 'ticket_c-9',
      output: {
        approved: false,
      },
      ifSettled: 'ignore',
    });
    expect(ignored).toBeNull();
  });

  it('.fail() delivers a failure envelope', async () => {
    const { accessor, get } = await pauseConversation();

    await legalReview.fail(client, {
      state: accessor,
      taskId: 'ticket_c-9',
      error: 'reviewer unavailable',
    });

    const messages = get()?.messages as Array<{
      role?: string;
      content?: string;
    }>;
    const envelope = messages.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope?.content).toContain('"status":"failed"');
    expect(envelope?.content).toContain('reviewer unavailable');
    // The persisted lifecycle status matches the outcome — not 'completed'.
    expect(get()?.pendingAsyncTools?.[0]?.status).toBe('failed');
  });

  it('.cancel() delivers a cancellation envelope', async () => {
    const { accessor, get } = await pauseConversation();

    await legalReview.cancel(client, {
      state: accessor,
      taskId: 'ticket_c-9',
      reason: 'contract withdrawn',
    });

    const messages = get()?.messages as Array<{
      role?: string;
      content?: string;
    }>;
    const envelope = messages.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope?.content).toContain('"status":"cancelled"');
    expect(envelope?.content).toContain('contract withdrawn');
    // The persisted lifecycle status matches the outcome — not 'completed'.
    expect(get()?.pendingAsyncTools?.[0]?.status).toBe('cancelled');
  });

  it('resumeToolResults resolves by callId too and throws for unknown tasks', async () => {
    const { accessor } = await pauseConversation();

    await expect(
      resumeToolResults(client, {
        state: accessor,
        results: [
          {
            taskId: 'nope',
            output: {},
          },
        ],
      }),
    ).rejects.toThrow('no pending async tool task');

    const result = await resumeToolResults(client, {
      state: accessor,
      tools: [
        legalReview,
      ] as const,
      results: [
        {
          callId: 'call_d1',
          output: {
            approved: true,
          },
        },
      ],
    });
    expect(result).toBeNull();
  });

  it('the paused state round-trips through JSON with async fields intact', async () => {
    const { get } = await pauseConversation();

    const roundTripped = JSON.parse(JSON.stringify(get())) as ConversationState;
    expect(roundTripped.status).toBe('awaiting_async_tools');
    expect(roundTripped.pendingAsyncTools?.[0]).toMatchObject({
      callId: 'call_d1',
      taskId: 'ticket_c-9',
      mode: 'defer',
    });
  });

  it('a fresh callModel({ state }) after record-only resolve delivers the envelope', async () => {
    const { accessor } = await pauseConversation();
    await legalReview.resolve(client, {
      state: accessor,
      taskId: 'ticket_c-9',
      output: {
        approved: true,
      },
    });

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_2', [
        messageItem('msg_1', 'done'),
      ]),
    });

    await callModel(client, {
      model: 'test-model',
      input: 'continue',
      tools: [
        legalReview,
      ] as const,
      state: accessor,
    }).getResponse();

    const input = mockBetaResponsesSend.mock.calls[0]?.[1]?.responsesRequest?.input as Array<{
      role?: string;
      content?: string;
    }>;
    const envelope = input.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope).toBeDefined();
  });
});

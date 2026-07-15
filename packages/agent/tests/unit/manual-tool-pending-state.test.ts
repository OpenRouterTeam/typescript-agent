import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { ConversationState, StateAccessor } from '../../src/index.js';
import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';
import { ToolType } from '../../src/lib/tool-types.js';

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

const autoTool = {
  type: ToolType.Function,
  function: {
    name: 'auto_search',
    description: 'Auto-executed tool.',
    inputSchema: z.object({
      query: z.string(),
    }),
    outputSchema: z.object({
      result: z.string(),
    }),
    execute: async (_params: { query: string }) => ({
      result: 'found it',
    }),
  },
} as const;

// No `execute` — the client is responsible for running this tool.
const manualTool = {
  type: ToolType.Function,
  function: {
    name: 'exec_command',
    description: 'Manual client-executed tool.',
    inputSchema: z.object({
      command: z.string(),
    }),
    outputSchema: z.object({
      stdout: z.string(),
    }),
  },
} as const;

const client = {} as OpenRouterCore;

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

describe('manual tool pending state (PR-4)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('all-manual round: stops loop, pendingToolCalls + status awaiting_client_tools', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_manual', [
        functionCallItem('call_manual_1', 'exec_command', '{"command":"ls"}'),
      ]),
    });

    const { accessor, get } = createMemoryAccessor();

    const result = callModel(client, {
      model: 'test-model',
      input: 'run ls',
      tools: [
        manualTool,
      ] as const,
      state: accessor,
    });

    const pending = await result.getPendingToolCalls();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('call_manual_1');
    expect(pending[0]?.name).toBe('exec_command');

    const state = await result.getState();
    expect(state.status).toBe('awaiting_client_tools');
    expect(state.pendingToolCalls).toHaveLength(1);
    expect(state.pendingToolCalls?.[0]?.id).toBe('call_manual_1');

    // No follow-up request — loop stopped after the unresolved manual call.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    const saved = get();
    expect(saved?.status).toBe('awaiting_client_tools');
    expect(saved?.pendingToolCalls?.[0]?.id).toBe('call_manual_1');
  });

  it('mixed regular+manual: auto output in messages, manual call in pendingToolCalls', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_mixed', [
        functionCallItem('call_auto_1', 'auto_search', '{"query":"docs"}'),
        functionCallItem('call_manual_1', 'exec_command', '{"command":"ls"}'),
      ]),
    });

    const { accessor, get } = createMemoryAccessor();

    const result = callModel(client, {
      model: 'test-model',
      input: 'do both',
      tools: [
        autoTool,
        manualTool,
      ] as const,
      state: accessor,
    });

    const pending = await result.getPendingToolCalls();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('call_manual_1');
    expect(pending[0]?.name).toBe('exec_command');

    // No follow-up with orphan function_call (same guard as mixed-manual-tool-round).
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    const state = await result.getState();
    expect(state.status).toBe('awaiting_client_tools');

    // Auto tool's output was persisted to state.messages; manual call was not
    // given an output item (client must supply it later).
    const messages = state.messages as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const autoOutput = messages.find(
      (m) => m.type === 'function_call_output' && m.callId === 'call_auto_1',
    );
    expect(autoOutput).toBeDefined();
    expect(autoOutput?.output).toContain('found it');

    const manualOutput = messages.find(
      (m) => m.type === 'function_call_output' && m.callId === 'call_manual_1',
    );
    expect(manualOutput).toBeUndefined();

    const saved = get();
    expect(saved?.status).toBe('awaiting_client_tools');
    expect(saved?.pendingToolCalls?.[0]?.id).toBe('call_manual_1');
  });

  it('JSON round-trip of paused state preserves pendingToolCalls and status', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_manual', [
        functionCallItem('call_manual_1', 'exec_command', '{"command":"pwd"}'),
      ]),
    });

    const { accessor } = createMemoryAccessor();

    const result = callModel(client, {
      model: 'test-model',
      input: 'run pwd',
      tools: [
        manualTool,
      ] as const,
      state: accessor,
    });

    const state = await result.getState();
    expect(state.status).toBe('awaiting_client_tools');
    expect(state.pendingToolCalls).toHaveLength(1);

    const roundTripped = JSON.parse(JSON.stringify(state)) as ConversationState;
    expect(roundTripped.status).toBe('awaiting_client_tools');
    expect(roundTripped.pendingToolCalls).toHaveLength(1);
    expect(roundTripped.pendingToolCalls?.[0]?.id).toBe('call_manual_1');
    expect(roundTripped.pendingToolCalls?.[0]?.name).toBe('exec_command');
    expect(roundTripped.pendingToolCalls?.[0]?.arguments).toEqual({
      command: 'pwd',
    });
  });

  it('no StateAccessor: nothing persisted, unresolved calls readable from the response', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_manual', [
        functionCallItem('call_manual_1', 'exec_command', '{"command":"ls"}'),
      ]),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'run ls',
      tools: [
        manualTool,
      ] as const,
      // no `state` accessor
    });

    // Loop still stops after the unresolved manual call — no follow-up
    // request with an orphan function_call.
    const response = await result.getResponse();
    expect(response.id).toBe('resp_manual');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    // Without an accessor there is no durable state, so pendings are empty;
    // the caller reads the unresolved calls off the response output.
    const pending = await result.getPendingToolCalls();
    expect(pending).toEqual([]);
    const calls = response.output.filter((item) => 'type' in item && item.type === 'function_call');
    expect(calls).toHaveLength(1);
  });

  it('clears pending manual calls only after a resume succeeds', async () => {
    const { accessor, get } = createMemoryAccessor();
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_manual', [
          functionCallItem('call_manual_1', 'exec_command', '{"command":"pwd"}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_done', [
          {
            id: 'msg_done',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'done',
                annotations: [],
              },
            ],
          },
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'run pwd',
      tools: [
        manualTool,
      ] as const,
      state: accessor,
    }).getPendingToolCalls();

    await callModel(client, {
      model: 'test-model',
      input: [
        {
          type: 'function_call_output',
          callId: 'call_manual_1',
          output: '{"stdout":"/tmp"}',
        },
      ],
      tools: [
        manualTool,
      ] as const,
      state: accessor,
    }).getResponse();

    expect(get()?.status).toBe('complete');
    expect(get()?.pendingToolCalls).toBeUndefined();
  });

  it('keeps pending manual calls when a resume request fails', async () => {
    const { accessor, get } = createMemoryAccessor();
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_manual', [
        functionCallItem('call_manual_1', 'exec_command', '{"command":"pwd"}'),
      ]),
    });

    await callModel(client, {
      model: 'test-model',
      input: 'run pwd',
      tools: [
        manualTool,
      ] as const,
      state: accessor,
    }).getPendingToolCalls();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: false,
      error: new Error('temporary failure'),
    });

    await expect(
      callModel(client, {
        model: 'test-model',
        input: [
          {
            type: 'function_call_output',
            callId: 'call_manual_1',
            output: '{"stdout":"/tmp"}',
          },
        ],
        tools: [
          manualTool,
        ] as const,
        state: accessor,
      }).getResponse(),
    ).rejects.toThrow('temporary failure');

    expect(get()?.status).toBe('awaiting_client_tools');
    expect(get()?.pendingToolCalls?.[0]?.id).toBe('call_manual_1');
  });

  it('does not mutate a loaded paused-state object before resume succeeds', async () => {
    const pausedState: ConversationState = {
      id: 'conv_manual',
      messages: [
        functionCallItem('call_manual_1', 'exec_command', '{"command":"pwd"}'),
      ],
      pendingToolCalls: [
        {
          id: 'call_manual_1',
          name: 'exec_command',
          arguments: {
            command: 'pwd',
          },
        },
      ],
      status: 'awaiting_client_tools',
      createdAt: 0,
      updatedAt: 0,
    };
    const accessor: StateAccessor = {
      load: async () => pausedState,
      save: async () => undefined,
    };
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_done', []),
    });

    await callModel(client, {
      model: 'test-model',
      input: [
        {
          type: 'function_call_output',
          callId: 'call_manual_1',
          output: '{"stdout":"/tmp"}',
        },
      ],
      tools: [
        manualTool,
      ] as const,
      state: accessor,
    }).getResponse();

    expect(pausedState.status).toBe('awaiting_client_tools');
    expect(pausedState.pendingToolCalls?.[0]?.id).toBe('call_manual_1');
  });

  it('HITL pause still yields awaiting_hitl (no regression)', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_hitl', [
        functionCallItem('call_hitl_1', 'approve', '{"amount":5}'),
      ]),
    });

    const approve = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
    });

    const { accessor, get } = createMemoryAccessor();

    const result = callModel(client, {
      model: 'test-model',
      input: 'approve 5',
      tools: [
        approve,
      ] as const,
      state: accessor,
    });

    await result.getResponse();

    const pending = await result.getPendingToolCalls();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('call_hitl_1');

    const state = await result.getState();
    expect(state.status).toBe('awaiting_hitl');
    expect(state.pendingToolCalls?.[0]?.id).toBe('call_hitl_1');

    const saved = get();
    expect(saved?.status).toBe('awaiting_hitl');
    // Distinct from awaiting_client_tools — HITL keeps its existing status.
    expect(saved?.status).not.toBe('awaiting_client_tools');
  });
});

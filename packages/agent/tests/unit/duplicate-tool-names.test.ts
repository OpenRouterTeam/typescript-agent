import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import type { ConversationState, StateAccessor, Tool } from '../../src/lib/tool-types.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

const { ModelResult } = await import('../../src/lib/model-result.js');
const { callModel } = await import('../../src/inner-loop/call-model.js');

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

function createMemoryAccessor<TTools extends readonly Tool[]>(): {
  accessor: StateAccessor<TTools>;
  get: () => ConversationState<TTools> | null;
} {
  let state: ConversationState<TTools> | null = null;
  return {
    accessor: {
      load: async () => state,
      save: async (next) => {
        state = next;
      },
    },
    get: () => state,
  };
}

const request = {
  model: 'test-model',
  input: 'read the value',
};

function makeTool(
  name: string,
  execute: (input: { slot: string }) => Promise<{
    ok: boolean;
  }>,
) {
  return tool({
    name,
    inputSchema: z.object({
      slot: z.string(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
    }),
    requireApproval: true,
    execute,
  });
}

describe('duplicate client tool names', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('rejects a tools list where two client tools share a name', () => {
    const first = makeTool('read_value', async () => ({
      ok: true,
    }));
    const second = makeTool('read_value', async () => ({
      ok: true,
    }));

    expect(
      () =>
        new ModelResult({
          request,
          client: {} as OpenRouterCore,
          tools: [
            first,
            second,
          ],
        }),
    ).toThrow(/Duplicate tool name "read_value"/);
    expect(() =>
      callModel({} as OpenRouterCore, {
        ...request,
        tools: [
          first,
          second,
        ],
      }),
    ).toThrow(/Duplicate tool name "read_value"/);
  });

  it('does not run an approved call on a different same-named tool added before resume', async () => {
    const approvedExecute = vi.fn(async () => ({
      ok: true,
    }));
    const otherExecute = vi.fn(async () => ({
      ok: true,
    }));
    const approved = makeTool('read_value', approvedExecute);
    const other = makeTool('read_value', otherExecute);

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_pause', [
        {
          type: 'function_call',
          id: 'fc_call_1',
          callId: 'call_1',
          name: 'read_value',
          arguments: '{"slot":"synthetic-marker"}',
          status: 'completed',
        },
      ]),
    });
    const memory = createMemoryAccessor<readonly Tool[]>();
    await new ModelResult<readonly Tool[]>({
      request,
      client: {} as OpenRouterCore,
      tools: [
        approved,
      ],
      state: memory.accessor,
    }).getResponse();
    expect(memory.get()?.status).toBe('awaiting_approval');

    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: makeResponse('resp_done', [
        {
          type: 'message',
          id: 'msg_1',
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
      ]),
    });

    let resumeError: unknown;
    try {
      await new ModelResult<readonly Tool[]>({
        request,
        client: {} as OpenRouterCore,
        tools: [
          other,
          approved,
        ],
        state: memory.accessor,
        approveToolCalls: [
          'call_1',
        ],
      }).getResponse();
    } catch (error) {
      resumeError = error;
    }

    expect(otherExecute).not.toHaveBeenCalled();
    expect(String(resumeError)).toMatch(/Duplicate tool name "read_value"/);
    expect(memory.get()?.status).toBe('awaiting_approval');
  });
});

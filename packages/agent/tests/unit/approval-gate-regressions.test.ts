import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { toolRequiresApproval } from '../../src/lib/conversation-state.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';
import { tool } from '../../src/lib/tool.js';
import type {
  ConversationState,
  StateAccessor,
  Tool,
  TurnContext,
} from '../../src/lib/tool-types.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

// Import ModelResult AFTER vi.mock so the transport mock is wired in.
const { ModelResult } = await import('../../src/lib/model-result.js');

const context: TurnContext = {
  numberOfTurns: 1,
};

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

function makeFunctionCallItem(
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

function createMemoryAccessor<TTools extends readonly Tool[]>(
  initial: ConversationState<TTools> | null = null,
): {
  accessor: StateAccessor<TTools>;
  get: () => ConversationState<TTools> | null;
} {
  let state = initial;
  const accessor: StateAccessor<TTools> = {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
  };
  return {
    accessor,
    get: () => state,
  };
}

// ---------------------------------------------------------------------------
// Bug 1: the approval predicate must see the SAME arguments `execute` gets —
// i.e. the values after the tool's Zod inputSchema applies defaults and
// coercions. Previously the predicate got the raw JSON.parse'd arguments, so a
// schema default could flip a dangerous flag on *after* the gate had already
// decided no approval was needed.
// ---------------------------------------------------------------------------
describe('approval predicate argument parity with execute (#54)', () => {
  it('applies inputSchema defaults before invoking a function-based requireApproval', async () => {
    const seenByPredicate: unknown[] = [];

    const conditional = tool({
      name: 'conditional_action',
      inputSchema: z.object({
        dangerous: z.boolean().default(true),
      }),
      requireApproval: (params) => {
        seenByPredicate.push(params);
        return params.dangerous === true;
      },
      execute: async () => ({}),
    });

    // The model emitted `{}` — `dangerous` is absent from the wire payload but
    // the schema default makes it `true` by the time `execute` runs.
    const emptyArgsCall = {
      id: '1',
      name: 'conditional_action',
      arguments: {},
    };

    const requires = await toolRequiresApproval(
      emptyArgsCall,
      [
        conditional,
      ],
      context,
    );

    expect(seenByPredicate).toEqual([
      {
        dangerous: true,
      },
    ]);
    expect(requires).toBe(true);
  });

  it('applies inputSchema coercions before invoking a function-based requireApproval', async () => {
    const seenByPredicate: unknown[] = [];

    const transfer = tool({
      name: 'transfer',
      inputSchema: z.object({
        amount: z.coerce.number(),
      }),
      requireApproval: (params) => {
        seenByPredicate.push(params);
        return params.amount > 100;
      },
      execute: async () => ({}),
    });

    // Model emitted the amount as a string; coercion turns it into a number,
    // so the `> 100` comparison must be numeric, not lexicographic.
    const stringAmountCall = {
      id: '2',
      name: 'transfer',
      arguments: {
        amount: '500',
      },
    };

    const requires = await toolRequiresApproval(
      stringAmountCall,
      [
        transfer,
      ],
      context,
    );

    expect(seenByPredicate).toEqual([
      {
        amount: 500,
      },
    ]);
    expect(requires).toBe(true);
  });

  it('fails closed (requires approval) when arguments do not satisfy the inputSchema', async () => {
    const predicate = vi.fn(() => false);

    const strict = tool({
      name: 'strict_action',
      inputSchema: z.object({
        target: z.string(),
      }),
      requireApproval: predicate,
      execute: async () => ({}),
    });

    // `target` is missing entirely — the schema parse fails. Rather than
    // handing the predicate a value `execute` would never see, the gate must
    // fail closed and require approval.
    const invalidCall = {
      id: '3',
      name: 'strict_action',
      arguments: {},
    };

    const requires = await toolRequiresApproval(
      invalidCall,
      [
        strict,
      ],
      context,
    );

    expect(requires).toBe(true);
    expect(predicate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bug 2: when `stopWhen` halts the loop on a turn that still has pending tool
// calls and `allowFinalResponse` is enabled, the pending calls were executed
// with no approval gate at all.
// ---------------------------------------------------------------------------
describe('allowFinalResponse path enforces the approval gate (#54)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('does not execute a requireApproval tool when stopWhen halts the loop', async () => {
    const safeExecute = vi.fn(async () => ({
      ok: true,
    }));
    const dangerExecute = vi.fn(async () => ({
      ok: true,
    }));

    const safe = tool({
      name: 'safe',
      inputSchema: z.object({
        target: z.string(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      execute: safeExecute,
    });

    const danger = tool({
      name: 'danger',
      inputSchema: z.object({
        target: z.string(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      requireApproval: true,
      execute: dangerExecute,
    });

    const tools = [
      safe,
      danger,
    ] as const;

    // Turn 0 calls the ungated tool so one round completes and the stop
    // condition (`stepCountIs(1)`) only fires on the NEXT iteration — which
    // breaks the loop with `stoppedByStopWhen`, reaching the post-loop
    // allowFinalResponse path. The follow-up response carries the gated call.
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_turn_0', [
          makeFunctionCallItem(
            'call_safe',
            'safe',
            JSON.stringify({
              target: 'staging',
            }),
          ),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_turn_1', [
          makeFunctionCallItem(
            'call_danger',
            'danger',
            JSON.stringify({
              target: 'prod',
            }),
          ),
        ]),
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_final', [
          {
            id: 'msg_final',
            type: 'message',
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

    const { accessor, get } = createMemoryAccessor<typeof tools>();

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'do the thing',
        tools: [
          {
            type: 'function',
            name: 'safe',
            description: null,
            strict: null,
            parameters: {},
          },
          {
            type: 'function',
            name: 'danger',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
      stopWhen: stepCountIs(1),
      allowFinalResponse: true,
    });

    await result.getResponse();

    // The ungated tool ran in the normal loop round.
    expect(safeExecute).toHaveBeenCalledTimes(1);

    // The gate must hold on the allowFinalResponse path too: the gated tool
    // never runs without approval.
    expect(dangerExecute).not.toHaveBeenCalled();

    // And the run pauses the same way the in-loop gate does.
    const saved = get();
    expect(saved?.status).toBe('awaiting_approval');
    expect(saved?.pendingToolCalls).toHaveLength(1);
    expect(saved?.pendingToolCalls?.[0]?.id).toBe('call_danger');
    expect(await result.requiresApproval()).toBe(true);

    // No final text-coercion request is made while paused: only the initial
    // request and the one follow-up went out.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('still runs non-gated tools on the allowFinalResponse path', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
    }));

    const safe = tool({
      name: 'safe',
      inputSchema: z.object({
        target: z.string(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      execute,
    });

    const tools = [
      safe,
    ] as const;

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_turn_0', [
          makeFunctionCallItem(
            'call_safe',
            'safe',
            JSON.stringify({
              target: 'staging',
            }),
          ),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_final', [
          {
            id: 'msg_final',
            type: 'message',
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

    const { accessor } = createMemoryAccessor<typeof tools>();

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'do the safe thing',
        tools: [
          {
            type: 'function',
            name: 'safe',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
      stopWhen: stepCountIs(0),
      allowFinalResponse: true,
    });

    const text = await result.getText();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(text).toBe('Done.');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });
});

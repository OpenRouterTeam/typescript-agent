import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { toolRequiresApproval } from '../../src/lib/conversation-state.js';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';
import { tool } from '../../src/lib/tool.js';
import {
  executeGeneratorTool,
  executeHITLTool,
  executeRegularTool,
  prepareUnifiedInvocation,
} from '../../src/lib/tool-executor.js';
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

  it('does not gate calls whose arguments fail schema validation', async () => {
    const predicate = vi.fn(() => false);

    const strict = tool({
      name: 'strict_action',
      inputSchema: z.object({
        target: z.string(),
      }),
      requireApproval: predicate,
      execute: async () => ({}),
    });

    // `target` is missing entirely — the schema parse fails. Such a call can
    // never execute (the executor runs the same schema through
    // validateToolInput and turns the failure into a tool error output), so
    // gating it would pause the run for a human to approve a call that can
    // only fail — or throw outright when no state accessor is configured.
    // The gate lets it through to the executor's normal validation error and
    // never invokes the predicate on a value `execute` would not see.
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

    expect(requires).toBe(false);
    expect(predicate).not.toHaveBeenCalled();
  });

  it('still fails closed when the schema parses to a non-object value', async () => {
    const predicate = vi.fn(() => false);

    // inputSchema is typed $ZodObject, but nothing enforces that at runtime —
    // a schema whose parse succeeds with a non-record payload would break the
    // predicate's Record<string, unknown> contract, so the gate fails closed.
    const weird = tool({
      name: 'weird_action',
      inputSchema: z.object({
        target: z.string(),
      }),
      requireApproval: predicate,
      execute: async () => ({}),
    });
    (
      weird.function as {
        inputSchema: unknown;
      }
    ).inputSchema = z
      .object({
        target: z.string(),
      })
      .transform(() => [
        'not',
        'a',
        'record',
      ]);

    const call = {
      id: '4',
      name: 'weird_action',
      arguments: {
        target: 'x',
      },
    };

    const requires = await toolRequiresApproval(
      call,
      [
        weird,
      ],
      context,
    );

    expect(requires).toBe(true);
    expect(predicate).not.toHaveBeenCalled();
  });

  it('still fails closed on schema-invalid arguments for manual (caller-executed) tools', async () => {
    const predicate = vi.fn(() => false);

    // A manual tool: no execute / onToolCalled / run. The engine never
    // validates or executes it — the call is surfaced on pendingToolCalls
    // for the host application to run as-is — so the "invalid arguments can
    // never execute" reasoning does not apply, and the gate must fail closed
    // rather than wave a malformed call past the approval check.
    const manualTool = {
      type: 'function',
      function: {
        name: 'manual_action',
        inputSchema: z.object({
          target: z.string(),
        }),
        requireApproval: predicate,
      },
    } as const;

    const invalidCall = {
      id: '5',
      name: 'manual_action',
      arguments: {},
    };

    const requires = await toolRequiresApproval(
      invalidCall,
      [
        manualTool,
      ],
      context,
    );

    expect(requires).toBe(true);
    expect(predicate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The gate's fail-open for schema-invalid arguments is only sound because
// every engine execute path re-validates with the tool's inputSchema before
// running the tool body. Lock that invariant in: if a future execute path
// (or a refactor of an existing one) ever skips validateToolInput, these
// tests fail — and the approval gate's fail-open must be revisited.
// ---------------------------------------------------------------------------
describe('every engine execute path validates before running the tool body', () => {
  const inputSchema = z.object({
    target: z.string(),
  });
  // Missing the required `target` — fails inputSchema validation.
  const invalidArguments = {};

  it('regular execute tools', async () => {
    const execute = vi.fn(async () => ({}));
    const regular = tool({
      name: 'regular',
      inputSchema,
      execute,
    });

    const result = await executeRegularTool(
      regular,
      {
        id: 'c1',
        name: 'regular',
        arguments: invalidArguments,
      },
      context,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.error).toBeDefined();
  });

  it('generator tools', async () => {
    const execute = vi.fn(async function* () {
      yield {
        progress: 1,
      };
      return {
        done: true,
      };
    });
    const generator = tool({
      name: 'generator',
      inputSchema,
      eventSchema: z.object({
        progress: z.number(),
      }),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      execute,
    });

    const result = await executeGeneratorTool(
      generator,
      {
        id: 'c2',
        name: 'generator',
        arguments: invalidArguments,
      },
      context,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.error).toBeDefined();
  });

  it('HITL onToolCalled tools', async () => {
    const onToolCalled = vi.fn(async () => ({}));
    const hitl = tool({
      name: 'hitl',
      inputSchema,
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled,
    });

    const result = await executeHITLTool(
      hitl,
      {
        id: 'c3',
        name: 'hitl',
        arguments: invalidArguments,
      },
      context,
    );

    expect(onToolCalled).not.toHaveBeenCalled();
    expect(result?.error).toBeDefined();
  });

  it('unified run tools', async () => {
    const run = vi.fn(async () => ({}));
    const unified = tool({
      name: 'unified',
      inputSchema,
      run,
    });

    const result = await prepareUnifiedInvocation(
      unified,
      {
        id: 'c4',
        name: 'unified',
        arguments: invalidArguments,
      },
      context,
    );

    expect(run).not.toHaveBeenCalled();
    expect('error' in result && result.error).toBeDefined();
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

  it('honors a PermissionRequest hook returning deny on the allowFinalResponse path', async () => {
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

    // The hook denies the gated call outright, so the run does NOT pause for a
    // human: handleApprovalCheck records the denial and returns false, and the
    // round synthesizes a rejection instead of executing.
    const hooks = new HooksManager();
    const permissionHandler = vi.fn(() => ({
      decision: 'deny' as const,
      reason: 'blocked by policy',
    }));
    hooks.on('PermissionRequest', {
      handler: permissionHandler,
    });

    // Same fixture shape as the gate test above: turn 0 calls the ungated tool
    // so one round completes and the stop condition fires on the NEXT
    // iteration, reaching the post-loop allowFinalResponse path with the gated
    // call pending.
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
                text: 'Denied.',
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
      hooks,
      state: accessor,
      stopWhen: stepCountIs(1),
      allowFinalResponse: true,
    });

    await result.getResponse();

    // The hook was consulted for the gated call — before the fix this path had
    // no approval check at all, so it never fired here.
    expect(permissionHandler).toHaveBeenCalledTimes(1);

    // The denied tool must not execute; the ungated one still runs normally.
    expect(dangerExecute).not.toHaveBeenCalled();
    expect(safeExecute).toHaveBeenCalledTimes(1);

    // A hook deny resolves the gate without a human, so the run does not pause
    // for approval.
    const saved = get();
    expect(saved?.status).not.toBe('awaiting_approval');

    // The rejection is recorded in state as a synthesized output for the denied
    // call, carrying the hook's reason.
    const outputs = (saved?.messages ?? []).filter(
      (m): m is models.FunctionCallOutputItem =>
        typeof m === 'object' &&
        m !== null &&
        'type' in m &&
        m.type === 'function_call_output' &&
        'callId' in m &&
        m.callId === 'call_danger',
    );
    expect(outputs).toHaveLength(1);
    expect(JSON.stringify(outputs[0]?.output)).toContain('blocked by policy');
  });

  it('surfaces schema-invalid arguments as a tool error instead of pausing or throwing', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
    }));

    const strict = tool({
      name: 'strict',
      inputSchema: z.object({
        target: z.string(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      requireApproval: (params) => params.target.length > 3,
      execute,
    });

    const tools = [
      strict,
    ] as const;

    // The model emits `{}` — `target` is missing, so the arguments can never
    // satisfy the schema. The gate must let the call through to the executor,
    // which turns the validation failure into a tool error output the model
    // can recover from. Gating it instead would pause the run for a human to
    // approve a call that can only fail — and with no state accessor
    // configured (as here), handleApprovalCheck would throw outright.
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_turn_0', [
          makeFunctionCallItem('call_strict', 'strict', '{}'),
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
                text: 'Recovered.',
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
        input: 'do the strict thing',
        tools: [
          {
            type: 'function',
            name: 'strict',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
    });

    const text = await result.getText();

    // No throw, no pause: the run completes normally.
    expect(text).toBe('Recovered.');
    const saved = get();
    expect(saved?.status).toBe('complete');

    // The tool body never ran — validation failed first — and the failure was
    // recorded as the call's output so the model could see it and recover.
    expect(execute).not.toHaveBeenCalled();
    const outputs = (saved?.messages ?? []).filter(
      (m): m is models.FunctionCallOutputItem =>
        typeof m === 'object' &&
        m !== null &&
        'type' in m &&
        m.type === 'function_call_output' &&
        'callId' in m &&
        m.callId === 'call_strict',
    );
    expect(outputs).toHaveLength(1);
    expect(JSON.stringify(outputs[0]?.output)).toContain('target');

    // One round trip for the initial request, one for the follow-up carrying
    // the validation error.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('gates the initial response only once when the stop condition fires on the first iteration', async () => {
    const dangerExecute = vi.fn(async () => ({
      ok: true,
    }));

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
      danger,
    ] as const;

    // The hook promotes the gated call past the gate.
    const hooks = new HooksManager();
    const permissionHandler = vi.fn(() => ({
      decision: 'allow' as const,
    }));
    hooks.on('PermissionRequest', {
      handler: permissionHandler,
    });

    // The initial response carries the gated call and stepCountIs(0) stops
    // the loop on the FIRST iteration, so the post-loop allowFinalResponse
    // path re-extracts the exact calls the pre-loop gate already checked.
    // Re-gating them would re-emit the PermissionRequest hook — a duplicate
    // prompt/audit record for a single tool call.
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_turn_0', [
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

    const { accessor } = createMemoryAccessor<typeof tools>();

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'do the thing',
        tools: [
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
      hooks,
      state: accessor,
      stopWhen: stepCountIs(0),
      allowFinalResponse: true,
    });

    const text = await result.getText();

    // Exactly one PermissionRequest emit for the single gated call — not one
    // per gate visit.
    expect(permissionHandler).toHaveBeenCalledTimes(1);

    // The hook allowed the call, so it executes exactly once on the
    // allowFinalResponse path and the final text is still produced.
    expect(dangerExecute).toHaveBeenCalledTimes(1);
    expect(text).toBe('Done.');
  });
});

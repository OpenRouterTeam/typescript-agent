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

  it('applies schema defaults for call-level checks without mutating the executable call', async () => {
    const defaulted = tool({
      name: 'call_level_defaulted_action',
      inputSchema: z.object({
        destructive: z.boolean().default(true),
      }),
      execute: async () => ({}),
    });
    const toolCall = {
      id: 'call-level-default',
      name: 'call_level_defaulted_action',
      arguments: {},
    };
    const callLevelCheck = vi.fn(() => true);

    const requires = await toolRequiresApproval(
      toolCall,
      [
        defaulted,
      ],
      context,
      callLevelCheck,
    );

    expect(callLevelCheck).toHaveBeenCalledWith(
      {
        ...toolCall,
        arguments: {
          destructive: true,
        },
      },
      context,
    );
    expect(toolCall.arguments).toEqual({});
    expect(requires).toBe(true);
  });

  it('honors a false call-level check when arguments fail schema validation', async () => {
    const strict = tool({
      name: 'call_level_invalid_action',
      inputSchema: z.object({
        target: z.string(),
      }),
      execute: async () => ({}),
    });
    const invalidCall = {
      id: 'call-level-invalid-false',
      name: 'call_level_invalid_action',
      arguments: {},
    };
    const callLevelCheck = vi.fn(() => false);

    expect(
      await toolRequiresApproval(
        invalidCall,
        [
          strict,
        ],
        context,
        callLevelCheck,
      ),
    ).toBe(false);
    expect(callLevelCheck).toHaveBeenCalledWith(invalidCall, context);
  });

  it('honors a true call-level check when arguments fail schema validation', async () => {
    const strict = tool({
      name: 'call_level_invalid_action',
      inputSchema: z.object({
        target: z.string(),
      }),
      execute: async () => ({}),
    });
    const invalidCall = {
      id: 'call-level-invalid-true',
      name: 'call_level_invalid_action',
      arguments: {},
    };
    const callLevelCheck = vi.fn(() => true);

    expect(
      await toolRequiresApproval(
        invalidCall,
        [
          strict,
        ],
        context,
        callLevelCheck,
      ),
    ).toBe(true);
    expect(callLevelCheck).toHaveBeenCalledWith(invalidCall, context);
  });

  it('parses original wire arguments once for the predicate and once for execution', async () => {
    let transformCalls = 0;
    const predicate = vi.fn(() => false);
    const execute = vi.fn(async () => ({}));
    const transformed = tool({
      name: 'transformed_action',
      inputSchema: z.object({
        value: z.string().transform((value) => `${value}:${++transformCalls}`),
      }),
      requireApproval: predicate,
      execute,
    });
    const toolCall = {
      id: 'non-idempotent-transform',
      name: 'transformed_action',
      arguments: {
        value: 'wire',
      },
    };

    expect(
      await toolRequiresApproval(
        toolCall,
        [
          transformed,
        ],
        context,
      ),
    ).toBe(false);
    await executeRegularTool(transformed, toolCall, context);

    expect(predicate).toHaveBeenCalledWith(
      {
        value: 'wire:1',
      },
      context,
    );
    expect(execute).toHaveBeenCalledWith(
      {
        value: 'wire:2',
      },
      expect.anything(),
    );
    expect(transformCalls).toBe(2);
    expect(toolCall.arguments).toEqual({
      value: 'wire',
    });
  });

  it('fails closed when arguments fail schema validation', async () => {
    const predicate = vi.fn(() => false);

    const strict = tool({
      name: 'strict_action',
      inputSchema: z.object({
        target: z.string(),
      }),
      requireApproval: predicate,
      execute: async () => ({}),
    });

    // `target` is missing entirely. A PreToolUse hook could replace this with
    // executable input later, so the gate cannot safely waive approval or
    // invoke the predicate with a value the tool body would never receive.
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

describe('approval uses the post-PreToolUse arguments that execute would receive', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  async function runMutationExploit(
    wireArguments: Record<string, unknown>,
    mutatedInput: Record<string, unknown>,
  ) {
    const predicate = vi.fn((params: { dangerous: boolean }) => params.dangerous);
    const execute = vi.fn(async () => ({
      ok: true,
    }));
    const guarded = tool({
      name: 'guarded_action',
      inputSchema: z.object({
        dangerous: z.boolean(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      requireApproval: predicate,
      execute,
    });
    const tools = [
      guarded,
    ] as const;
    const hooks = new HooksManager();
    hooks.on('PreToolUse', {
      handler: () => ({
        mutatedInput,
      }),
    });
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_mutation', [
        makeFunctionCallItem('call_guarded', 'guarded_action', JSON.stringify(wireArguments)),
      ]),
    });
    const { accessor, get } = createMemoryAccessor<typeof tools>();
    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'run the guarded action',
        tools: [
          {
            type: 'function',
            name: 'guarded_action',
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
    });

    await result.getResponse();

    expect(predicate).toHaveBeenCalledWith(mutatedInput, {
      numberOfTurns: 0,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(get()?.status).toBe('awaiting_approval');
    expect(get()?.pendingToolCalls).toEqual([
      {
        id: 'call_guarded',
        name: 'guarded_action',
        arguments: mutatedInput,
        preToolUseApplied: true,
      },
    ]);
  }

  it('does not let a hook rewrite safe arguments into an unapproved dangerous call', async () => {
    await runMutationExploit(
      {
        dangerous: false,
      },
      {
        dangerous: true,
      },
    );
  });

  it('does not abort approval bookkeeping for circular hook mutations', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const predicate = vi.fn(() => false);
    const execute = vi.fn(async () => ({
      ok: true,
    }));
    const guarded = tool({
      name: 'circular_mutation',
      inputSchema: z.object({
        self: z.unknown(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      requireApproval: predicate,
      execute,
    });
    const tools = [
      guarded,
    ] as const;
    const hooks = new HooksManager();
    hooks.on('PreToolUse', {
      handler: () => ({
        mutatedInput: circular,
      }),
    });
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_circular_mutation', [
          makeFunctionCallItem('call_circular_mutation', 'circular_mutation', '{}'),
        ]),
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_circular_done', []),
      });

    await expect(
      new ModelResult<typeof tools>({
        request: {
          model: 'test-model',
          input: 'run',
          tools: [],
        },
        client: {} as OpenRouterCore,
        tools,
        hooks,
      }).getResponse(),
    ).resolves.toBeDefined();
    expect(predicate).toHaveBeenCalledWith(circular, {
      numberOfTurns: 0,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets normal validation handle deeply nested model input when keying cannot', async () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 200; index++) {
      deep = {
        child: deep,
      };
    }
    const execute = vi.fn(async () => ({
      ok: true,
    }));
    const strict = tool({
      name: 'deep_invalid',
      inputSchema: z.object({
        target: z.string(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      requireApproval: () => false,
      execute,
    });
    const tools = [
      strict,
    ] as const;
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_deep_invalid', [
        makeFunctionCallItem('call_deep_invalid', 'deep_invalid', JSON.stringify(deep)),
      ]),
    });
    const { accessor, get } = createMemoryAccessor<typeof tools>();

    await expect(
      new ModelResult<typeof tools>({
        request: {
          model: 'test-model',
          input: 'run',
          tools: [],
        },
        client: {} as OpenRouterCore,
        tools,
        state: accessor,
      }).getResponse(),
    ).resolves.toBeDefined();
    expect(get()?.status).toBe('awaiting_approval');
    expect(execute).not.toHaveBeenCalled();
  });

  it('gates identical post-hook calls independently across responses', async () => {
    const predicate = vi.fn((params: { dangerous: boolean }) => params.dangerous);
    const execute = vi.fn(async () => ({
      ok: true,
    }));
    const guarded = tool({
      name: 'guarded_action',
      inputSchema: z.object({
        dangerous: z.boolean(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      requireApproval: predicate,
      execute,
    });
    const tools = [
      guarded,
    ] as const;
    const hooks = new HooksManager();
    hooks.on('PreToolUse', {
      handler: () => ({
        mutatedInput: {
          dangerous: true,
        },
      }),
    });
    const permissionRequest = vi.fn(() => ({
      decision: 'allow' as const,
    }));
    hooks.on('PermissionRequest', {
      handler: permissionRequest,
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_mutation_reused', [
          makeFunctionCallItem(
            'call_reused',
            'guarded_action',
            JSON.stringify({
              dangerous: false,
            }),
          ),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_mutation_reused', [
          makeFunctionCallItem(
            'call_reused',
            'guarded_action',
            JSON.stringify({
              dangerous: false,
            }),
          ),
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
                text: 'Done.',
                annotations: [],
              },
            ],
          },
        ]),
      });

    await new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'run twice',
        tools: [],
      },
      client: {} as OpenRouterCore,
      tools,
      hooks,
    }).getResponse();

    expect(predicate.mock.calls.filter(([params]) => params.dangerous === true)).toHaveLength(2);
    expect(permissionRequest).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps hook-mutated arguments raw across approval and execution transforms', async () => {
    const predicate = vi.fn((params: { value: string }) => params.value === 'hook:normalized');
    const execute = vi.fn(async (input: { value: string }) => ({
      value: input.value,
    }));
    const guarded = tool({
      name: 'transformed_mutation',
      inputSchema: z.object({
        value: z.string().transform((value) => `${value}:normalized`),
      }),
      outputSchema: z.object({
        value: z.string(),
      }),
      requireApproval: predicate,
      execute,
    });
    const tools = [
      guarded,
    ] as const;
    const hooks = new HooksManager();
    hooks.on('PreToolUse', {
      handler: () => ({
        mutatedInput: {
          value: 'hook',
        },
      }),
    });
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_transformed_mutation', [
        makeFunctionCallItem(
          'call_transformed_mutation',
          'transformed_mutation',
          JSON.stringify({
            value: 'wire',
          }),
        ),
      ]),
    });
    const { accessor, get } = createMemoryAccessor<typeof tools>();

    await new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'run',
        tools: [],
      },
      client: {} as OpenRouterCore,
      tools,
      hooks,
      state: accessor,
    }).getResponse();

    expect(predicate).toHaveBeenLastCalledWith(
      {
        value: 'hook:normalized',
      },
      {
        numberOfTurns: 0,
      },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(get()?.pendingToolCalls).toEqual([
      {
        id: 'call_transformed_mutation',
        name: 'transformed_mutation',
        arguments: {
          value: 'hook',
        },
        preToolUseApplied: true,
      },
    ]);
  });

  it('executes a type-changing hook mutation from raw input exactly once', async () => {
    const execute = vi.fn(async (input: { value: number }) => ({
      value: input.value,
    }));
    const transformed = tool({
      name: 'type_changing_mutation',
      inputSchema: z.object({
        value: z.string().transform((value) => value.length),
      }),
      outputSchema: z.object({
        value: z.number(),
      }),
      requireApproval: () => false,
      execute,
    });
    const tools = [
      transformed,
    ] as const;
    const hooks = new HooksManager();
    hooks.on('PreToolUse', {
      handler: () => ({
        mutatedInput: {
          value: 'hook',
        },
      }),
    });
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_type_changing_mutation', [
          makeFunctionCallItem(
            'call_type_changing_mutation',
            'type_changing_mutation',
            JSON.stringify({
              value: 'wire',
            }),
          ),
        ]),
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_type_changing_done', []),
      });

    await new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'run',
        tools: [],
      },
      client: {} as OpenRouterCore,
      tools,
      hooks,
    }).getResponse();

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      {
        value: 4,
      },
      expect.anything(),
    );
  });

  it('gates schema-invalid model arguments before running PreToolUse', async () => {
    const preToolUse = vi.fn(() => ({
      mutatedInput: {
        dangerous: true,
      },
    }));
    const execute = vi.fn(async () => ({
      ok: true,
    }));
    const guarded = tool({
      name: 'guarded_action',
      inputSchema: z.object({
        dangerous: z.boolean(),
      }),
      requireApproval: (params) => params.dangerous,
      execute,
    });
    const tools = [
      guarded,
    ] as const;
    const hooks = new HooksManager();
    hooks.on('PreToolUse', {
      handler: preToolUse,
    });
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_invalid_original', [
        makeFunctionCallItem('call_invalid_original', 'guarded_action', '{}'),
      ]),
    });
    const { accessor, get } = createMemoryAccessor<typeof tools>();

    await new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'run',
        tools: [],
      },
      client: {} as OpenRouterCore,
      tools,
      hooks,
      state: accessor,
    }).getResponse();

    expect(preToolUse).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(get()?.status).toBe('awaiting_approval');
  });

  it('persists unconditional approvals with post-hook arguments and does not reapply the hook on resume', async () => {
    const preToolUse = vi.fn(({ toolInput }: { toolInput: Record<string, unknown> }) => ({
      mutatedInput: {
        value: `${String(toolInput['value'])}-prepared`,
      },
    }));
    const permissionRequest = vi.fn(() => ({
      decision: 'ask_user' as const,
    }));
    const execute = vi.fn(async (input: { value: string }) => ({
      value: input.value,
    }));
    const guarded = tool({
      name: 'always_guarded',
      inputSchema: z.object({
        value: z.string(),
      }),
      outputSchema: z.object({
        value: z.string(),
      }),
      requireApproval: true,
      execute,
    });
    const tools = [
      guarded,
    ] as const;
    const hooks = new HooksManager();
    hooks.on('PreToolUse', {
      handler: preToolUse,
    });
    hooks.on('PermissionRequest', {
      handler: permissionRequest,
    });
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_unconditional', [
        makeFunctionCallItem(
          'call_unconditional',
          'always_guarded',
          JSON.stringify({
            value: 'original',
          }),
        ),
      ]),
    });
    const { accessor, get } = createMemoryAccessor<typeof tools>();
    const request = {
      model: 'test-model',
      input: 'run the guarded action',
      tools: [
        {
          type: 'function' as const,
          name: 'always_guarded',
          description: null,
          strict: null,
          parameters: {},
        },
      ],
    };

    await new ModelResult<typeof tools>({
      request,
      client: {} as OpenRouterCore,
      tools,
      hooks,
      state: accessor,
    }).getResponse();

    expect(permissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        toolInput: {
          value: 'original',
        },
      }),
      expect.anything(),
    );
    expect(get()?.pendingToolCalls).toEqual([
      {
        id: 'call_unconditional',
        name: 'always_guarded',
        arguments: {
          value: 'original',
        },
      },
    ]);
    const legacyState = structuredClone(get());
    if (legacyState?.pendingToolCalls?.[0]) {
      delete legacyState.pendingToolCalls[0].preToolUseApplied;
    }

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_after_approval', [
        {
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
    await new ModelResult<typeof tools>({
      request,
      client: {} as OpenRouterCore,
      tools,
      hooks,
      state: accessor,
      approveToolCalls: [
        'call_unconditional',
      ],
    }).getResponse();

    expect(preToolUse).toHaveBeenCalledTimes(1);
    expect(permissionRequest).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      {
        value: 'original-prepared',
      },
      expect.anything(),
    );

    const { accessor: legacyAccessor } = createMemoryAccessor(legacyState);
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_after_legacy_approval', [
        {
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
    await new ModelResult<typeof tools>({
      request,
      client: {} as OpenRouterCore,
      tools,
      hooks,
      state: legacyAccessor,
      approveToolCalls: [
        'call_unconditional',
      ],
    }).getResponse();

    expect(preToolUse).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      {
        value: 'original-prepared',
      },
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Every engine execute path validates before running the tool body. This is
// still required for ordinary validation errors, independent of approval.
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

  it('fails closed on schema-invalid arguments that no hook repairs', async () => {
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

    // The model emits `{}` — `target` is missing. Because a PreToolUse hook
    // could repair it before execution, the predicate has no safe value to
    // inspect and the gate fails closed.
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

    await result.getResponse();

    const saved = get();
    expect(saved?.status).toBe('awaiting_approval');
    expect(saved?.pendingToolCalls).toEqual([
      {
        id: 'call_strict',
        name: 'strict',
        arguments: {},
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
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

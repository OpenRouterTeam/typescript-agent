import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { ConversationState, StateAccessor } from '../../src/index.js';
import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';
import { convertToolsToAPIFormat } from '../../src/lib/tool-executor.js';

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

/** Long-running tool that yields progress then blocks until released. */
function makeObservableTool() {
  let release: ((value: { url: string }) => void) | undefined;
  const gate = new Promise<{
    url: string;
  }>((resolve) => {
    release = resolve;
  });
  const built = tool({
    name: 'render_video',
    lifecycle: 'background',
    inputSchema: z.object({
      script: z.string(),
    }),
    outputSchema: z.object({
      url: z.string(),
    }),
    graceMs: 0,
    run: async function* () {
      yield {
        step: 'downloading assets',
      };
      yield {
        step: 'rendering frames',
      };
      return await gate;
    },
  });
  return {
    tool: built,
    release: (value: { url: string }) => release?.(value),
  };
}

describe('check-in wire schema', () => {
  it('long-running tools get anyOf [start, check] parameters; sync tools do not', () => {
    const longRunning = tool({
      name: 'lr',
      lifecycle: 'background',
      inputSchema: z.object({
        q: z.string(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      run: async () => ({
        ok: true,
      }),
    });
    const syncTool = tool({
      name: 'sync',
      inputSchema: z.object({
        q: z.string(),
      }),
      run: async () => ({
        ok: true,
      }),
    });

    const api = convertToolsToAPIFormat([
      longRunning,
      syncTool,
    ]) as Array<{
      name: string;
      parameters: Record<string, unknown>;
    }>;

    const lrParams = api[0]?.parameters as {
      anyOf?: Array<Record<string, unknown>>;
    };
    expect(lrParams.anyOf).toHaveLength(2);
    const checkBranch = lrParams.anyOf?.[1] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(checkBranch.required).toEqual([
      'taskId',
    ]);
    expect(Object.keys(checkBranch.properties)).toContain('view');
    expect(Object.keys(checkBranch.properties)).toContain('tail');

    const syncParams = api[1]?.parameters as {
      anyOf?: unknown;
    };
    expect(syncParams.anyOf).toBeUndefined();
  });

  it("custom check.schema shapes the check branch's params", () => {
    const custom = tool({
      name: 'custom_check',
      lifecycle: 'background',
      inputSchema: z.object({
        q: z.string(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      check: {
        schema: z.object({
          steer: z.string().optional(),
        }),
      },
      run: async () => ({
        ok: true,
      }),
    });
    const api = convertToolsToAPIFormat([
      custom,
    ]) as Array<{
      parameters: {
        anyOf: Array<{
          properties: Record<string, unknown>;
        }>;
      };
    }>;
    const checkBranch = api[0]?.parameters.anyOf[1];
    expect(Object.keys(checkBranch?.properties ?? {})).toEqual([
      'taskId',
      'steer',
    ]);
  });
});

describe('check-in dispatch (same-tool taskId call)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  /**
   * Drive: turn 1 starts a background task (placeholder), turn 2 the model
   * issues a CHECK call ({taskId, ...checkArgs}), turn 3 finishes. Returns
   * the check call's function_call_output payload.
   */
  async function driveCheck(
    observable: ReturnType<typeof makeObservableTool>,
    checkArgs: Record<string, unknown>,
    options?: {
      releaseBeforeEnd?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    mockBetaResponsesSend
      .mockImplementationOnce(async () => ({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_start', 'render_video', '{"script":"hi"}'),
        ]),
      }))
      // Model checks on the task while it runs.
      .mockImplementationOnce(async () => {
        // Extract the taskId the placeholder advertised.
        const input = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as Array<{
          type?: string;
          callId?: string;
          output?: string;
        }>;
        const placeholder = input.find(
          (m) => m.type === 'function_call_output' && m.callId === 'call_start',
        );
        const taskId = (
          JSON.parse(placeholder?.output ?? '{}') as {
            taskId: string;
          }
        ).taskId;
        return {
          ok: true,
          value: makeResponse('resp_2', [
            functionCallItem(
              'call_check',
              'render_video',
              JSON.stringify({
                taskId,
                ...checkArgs,
              }),
            ),
          ]),
        };
      })
      .mockImplementationOnce(async () => {
        if (options?.releaseBeforeEnd !== false) {
          observable.release({
            url: 'https://cdn/final.mp4',
          });
        }
        return {
          ok: true,
          value: makeResponse('resp_3', [
            messageItem('msg_1', 'done'),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_4', [
          messageItem('msg_2', 'final'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        observable.tool,
      ] as const,
      asyncTools: {
        drainTimeoutMs: 5_000,
      },
    }).getText();

    // The check call's output rides the third request's input.
    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const checkOutput = thirdInput.find(
      (m) => m.type === 'function_call_output' && m.callId === 'call_check',
    );
    return JSON.parse(checkOutput?.output ?? '{}') as Record<string, unknown>;
  }

  it('default status view: working task with logCount and lastLog', async () => {
    const observable = makeObservableTool();
    const result = await driveCheck(observable, {});
    expect(result['status']).toBe('working');
    expect(result['toolName']).toBe('render_video');
    expect(result['mode']).toBe('background');
    expect(result['logCount']).toBe(2);
    expect(result['lastLog']).toEqual({
      step: 'rendering frames',
    });
    expect(typeof result['elapsedMs']).toBe('number');
  });

  it('logs view returns the yielded entries (tail respected)', async () => {
    const observable = makeObservableTool();
    const result = await driveCheck(observable, {
      view: 'logs',
      tail: 1,
    });
    const logs = result['logs'] as Array<{
      data: unknown;
    }>;
    expect(logs).toHaveLength(1);
    expect(logs[0]?.data).toEqual({
      step: 'rendering frames',
    });
  });

  it('transcript view renders the log entries as text', async () => {
    const observable = makeObservableTool();
    const result = await driveCheck(observable, {
      view: 'transcript',
    });
    const transcript = result['transcript'] as string;
    expect(transcript).toContain('downloading assets');
    expect(transcript).toContain('rendering frames');
  });

  it('unknown taskId yields an error result, not a new task', async () => {
    const observable = makeObservableTool();
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_start', 'render_video', '{"script":"hi"}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          functionCallItem('call_check', 'render_video', '{"taskId":"task_nope"}'),
        ]),
      })
      .mockImplementationOnce(async () => {
        observable.release({
          url: 'x',
        });
        return {
          ok: true,
          value: makeResponse('resp_3', [
            messageItem('msg_1', 'done'),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_4', [
          messageItem('msg_2', 'final'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        observable.tool,
      ] as const,
    }).getText();

    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const checkOutput = thirdInput.find(
      (m) => m.type === 'function_call_output' && m.callId === 'call_check',
    );
    expect(checkOutput?.output).toContain('unknown_task');
  });

  it('custom check.execute receives toolCallStatus + accumulatedYieldedEvents and can steer', async () => {
    const steered: unknown[] = [];
    let release: ((value: { ok: boolean }) => void) | undefined;
    const gate = new Promise<{
      ok: boolean;
    }>((resolve) => {
      release = resolve;
    });
    const steerable = tool({
      name: 'steerable',
      lifecycle: 'background',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      graceMs: 0,
      check: {
        schema: z.object({
          steer: z.string().optional(),
        }),
        execute: async (params, turnContext) => {
          if (typeof params['steer'] === 'string') {
            turnContext.task?.send(params['steer']);
          }
          return {
            state: turnContext.toolCallStatus,
            seen: turnContext.accumulatedYieldedEvents?.length ?? 0,
          };
        },
      },
      run: async function* (_params, ctx) {
        ctx?.onMessage((msg) => steered.push(msg));
        yield 'starting';
        return await gate;
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_s', 'steerable', '{}'),
        ]),
      })
      .mockImplementationOnce(async () => {
        const input = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as Array<{
          type?: string;
          callId?: string;
          output?: string;
        }>;
        const placeholder = input.find(
          (m) => m.type === 'function_call_output' && m.callId === 'call_s',
        );
        const taskId = (
          JSON.parse(placeholder?.output ?? '{}') as {
            taskId: string;
          }
        ).taskId;
        return {
          ok: true,
          value: makeResponse('resp_2', [
            functionCallItem(
              'call_check',
              'steerable',
              JSON.stringify({
                taskId,
                steer: 'focus on pricing',
              }),
            ),
          ]),
        };
      })
      .mockImplementationOnce(async () => {
        release?.({
          ok: true,
        });
        return {
          ok: true,
          value: makeResponse('resp_3', [
            messageItem('msg_1', 'done'),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_4', [
          messageItem('msg_2', 'final'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        steerable,
      ] as const,
    }).getText();

    expect(steered).toEqual([
      'focus on pricing',
    ]);
    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const checkOutput = JSON.parse(
      thirdInput.find((m) => m.type === 'function_call_output' && m.callId === 'call_check')
        ?.output as string,
    ) as Record<string, unknown>;
    expect(checkOutput['state']).toBe('working');
    expect(checkOutput['seen']).toBe(1);
  });

  it('check calls are exempt from doom-loop detection (repeat polling never blocks)', async () => {
    const observable = makeObservableTool();
    const checkCallCount = 6;

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        functionCallItem('call_start', 'render_video', '{"script":"hi"}'),
      ]),
    });

    // The model polls with IDENTICAL args six times in a row.
    for (let i = 0; i < checkCallCount; i++) {
      mockBetaResponsesSend.mockImplementationOnce(async () => {
        const input = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as Array<{
          type?: string;
          callId?: string;
          output?: string;
        }>;
        const placeholder = input.find(
          (m) => m.type === 'function_call_output' && m.callId === 'call_start',
        );
        const taskId = (
          JSON.parse(placeholder?.output ?? '{}') as {
            taskId: string;
          }
        ).taskId;
        return {
          ok: true,
          value: makeResponse(`resp_check_${i}`, [
            functionCallItem(
              `call_check_${i}`,
              'render_video',
              JSON.stringify({
                taskId,
              }),
            ),
          ]),
        };
      });
    }
    mockBetaResponsesSend
      .mockImplementationOnce(async () => {
        observable.release({
          url: 'x',
        });
        return {
          ok: true,
          value: makeResponse('resp_done', [
            messageItem('msg_1', 'done'),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_final', [
          messageItem('msg_2', 'final'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        observable.tool,
      ] as const,
      doomLoop: true,
    });

    await result.getText();

    // No block/stop verdict — every check answered normally.
    expect(await result.getDoomLoopVerdict()).toBeNull();
    for (let i = 0; i < checkCallCount; i++) {
      const requestInput = mockBetaResponsesSend.mock.calls[i + 2]?.[1]?.responsesRequest
        ?.input as Array<{
        type?: string;
        callId?: string;
        output?: string;
      }>;
      const checkOutput = requestInput.find(
        (m) => m.type === 'function_call_output' && m.callId === `call_check_${i}`,
      );
      expect(checkOutput?.output).toContain('"status":"working"');
      expect(checkOutput?.output).not.toContain('Doom loop');
    }
  });

  it('asyncTools.checkins: false restores the no-polling placeholder and disables dispatch', async () => {
    const observable = makeObservableTool();
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_start', 'render_video', '{"script":"hi"}'),
        ]),
      })
      .mockImplementationOnce(async () => {
        observable.release({
          url: 'x',
        });
        return {
          ok: true,
          value: makeResponse('resp_2', [
            messageItem('msg_1', 'done'),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_2', 'final'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        observable.tool,
      ] as const,
      asyncTools: {
        checkins: false,
      },
    }).getText();

    const secondInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const placeholder = secondInput.find(
      (m) => m.type === 'function_call_output' && m.callId === 'call_start',
    );
    expect(placeholder?.output).toContain('do not call this tool again');
    expect(placeholder?.output).not.toContain('To check progress');
  });

  it('post-restart deferred check answers from persisted state (status + note, no transcript)', async () => {
    const deferred = tool({
      name: 'legal_review',
      lifecycle: 'deferred',
      inputSchema: z.object({
        id: z.string(),
      }),
      outputSchema: z.object({
        approved: z.boolean(),
      }),
      run: async ({ id }, ctx) => {
        if (!ctx) {
          throw new Error('no ctx');
        }
        return ctx.defer(`ticket_${id}`, {
          pollAfterMs: 60_000,
        });
      },
    });

    const { accessor } = createMemoryAccessor();

    // Process A: start and pause.
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        functionCallItem('call_d', 'legal_review', '{"id":"c1"}'),
      ]),
    });
    await callModel(client, {
      model: 'test-model',
      input: 'review',
      tools: [
        deferred,
      ] as const,
      state: accessor,
    }).getState();
    mockBetaResponsesSend.mockReset();

    // Process B (fresh callModel — simulated restart): model checks on it.
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          functionCallItem(
            'call_check',
            'legal_review',
            '{"taskId":"ticket_c1","view":"transcript"}',
          ),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_1', 'still waiting'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'any update?',
      tools: [
        deferred,
      ] as const,
      state: accessor,
    }).getText();

    const secondInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const checkOutput = JSON.parse(
      secondInput.find((m) => m.type === 'function_call_output' && m.callId === 'call_check')
        ?.output as string,
    ) as Record<string, unknown>;
    expect(checkOutput['status']).toBe('working');
    expect(checkOutput['mode']).toBe('defer');
    expect(checkOutput['pollAfterMs']).toBe(60_000);
    expect(checkOutput['note']).toContain('external system');
  });
});

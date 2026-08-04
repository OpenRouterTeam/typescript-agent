import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { callModel } from '../../src/inner-loop/call-model.js';
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

/**
 * Controllable background tool: yields one log entry, records steering
 * messages, then blocks until the test releases (or rejects) it.
 */
function makeControlledTool(name = 'worker') {
  let release: ((value: { output: string }) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const steered: unknown[] = [];
  const gate = new Promise<{
    output: string;
  }>((resolve, rej) => {
    release = resolve;
    reject = rej;
  });
  const built = tool({
    name,
    lifecycle: 'background',
    inputSchema: z.object({
      job: z.string(),
    }),
    outputSchema: z.object({
      output: z.string(),
    }),
    graceMs: 0,
    run: async function* (_params, ctx) {
      ctx?.onMessage((msg) => steered.push(msg));
      yield {
        step: 'working',
      };
      return await gate;
    },
  });
  return {
    tool: built,
    steered,
    release: (value: { output: string }) => release?.(value),
    fail: (error: Error) => reject?.(error),
  };
}

/**
 * Drive a run where: turn 1 starts the worker (placeholder), turn 2 the
 * model issues ONE task-tool call built from the advertised taskId, turn 3
 * settles the worker and finishes. Returns the task call's parsed output.
 */
async function driveTaskCall(
  controlled: ReturnType<typeof makeControlledTool>,
  buildArgs: (taskId: string) => Record<string, unknown>,
  options?: {
    settle?: (controlled: ReturnType<typeof makeControlledTool>) => void;
  },
): Promise<Record<string, unknown>> {
  mockBetaResponsesSend
    .mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        functionCallItem('call_start', 'worker', '{"job":"j1"}'),
      ]),
    })
    .mockImplementationOnce(async () => {
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
          functionCallItem('call_task', 'task', JSON.stringify(buildArgs(taskId))),
        ]),
      };
    })
    .mockImplementationOnce(async () => {
      (
        options?.settle ??
        ((c: ReturnType<typeof makeControlledTool>) =>
          c.release({
            output: 'finished',
          }))
      )(controlled);
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
      controlled.tool,
    ] as const,
    asyncTools: {
      drainTimeoutMs: 5_000,
    },
  }).getText();

  const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
    type?: string;
    callId?: string;
    output?: string;
  }>;
  const taskOutput = thirdInput.find(
    (m) => m.type === 'function_call_output' && m.callId === 'call_task',
  );
  return JSON.parse(taskOutput?.output ?? '{}') as Record<string, unknown>;
}

describe('task tool — action: steer', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('delivers the message to the run body and confirms', async () => {
    const controlled = makeControlledTool();
    const result = await driveTaskCall(controlled, (taskId) => ({
      taskId,
      action: 'steer',
      message: 'prioritize speed',
    }));

    expect(result).toEqual({
      taskId: expect.stringMatching(/^task_/),
      steered: true,
    });
    expect(controlled.steered).toEqual([
      'prioritize speed',
    ]);
  });

  it('rejects steer without a message (error output; run continues)', async () => {
    const controlled = makeControlledTool();
    const result = await driveTaskCall(controlled, (taskId) => ({
      taskId,
      action: 'steer',
    }));

    expect(String(result['error'])).toContain('message');
    expect(controlled.steered).toEqual([]);
  });

  it('reports not_steerable for deferred tasks (external system owns them)', async () => {
    const deferred = tool({
      name: 'external_job',
      lifecycle: 'deferred',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      run: async (_params, ctx) => {
        if (!ctx) {
          throw new Error('no ctx');
        }
        return ctx.defer('ext_1');
      },
    });

    // Deferred pauses the run; the model's steer attempt happens on resume.
    const stored: {
      state: unknown;
    } = {
      state: null,
    };
    const accessor = {
      load: async () => stored.state as never,
      save: async (s: unknown) => {
        stored.state = s;
      },
    };

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        functionCallItem('call_d', 'external_job', '{}'),
      ]),
    });
    await callModel(client, {
      model: 'test-model',
      input: 'start',
      tools: [
        deferred,
      ] as const,
      state: accessor,
    }).getState();
    mockBetaResponsesSend.mockReset();

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          functionCallItem(
            'call_task',
            'task',
            '{"taskId":"ext_1","action":"steer","message":"hurry"}',
          ),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_1', 'ok'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'steer it',
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
    const taskOutput = JSON.parse(
      secondInput.find((m) => m.type === 'function_call_output' && m.callId === 'call_task')
        ?.output as string,
    ) as Record<string, unknown>;
    expect(taskOutput['error']).toBe('not_steerable');
    expect(String(taskOutput['hint'])).toContain('external system');
  });
});

describe('task tool — action: result', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('returns the status view while the task is still working', async () => {
    const controlled = makeControlledTool();
    const result = await driveTaskCall(controlled, (taskId) => ({
      taskId,
      action: 'result',
    }));

    // Unsettled: falls through to the status view.
    expect(result['status']).toBe('working');
    expect(result['toolName']).toBe('worker');
    expect(result['result']).toBeUndefined();
  });

  it('returns the final result once the task settled (before delivery)', async () => {
    const controlled = makeControlledTool();

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_start', 'worker', '{"job":"j1"}'),
        ]),
      })
      // Settle the work DURING this dispatch, then have the model ask for
      // the result in the same response — the task is settled but its
      // envelope has not been injected yet.
      .mockImplementationOnce(async () => {
        controlled.release({
          output: 'the answer',
        });
        // Give the settle microtask a beat so the registry records it.
        await new Promise((resolve) => setTimeout(resolve, 20));
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
              'call_task',
              'task',
              JSON.stringify({
                taskId,
                action: 'result',
              }),
            ),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_1', 'done'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        controlled.tool,
      ] as const,
    }).getText();

    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const taskOutput = JSON.parse(
      thirdInput.find((m) => m.type === 'function_call_output' && m.callId === 'call_task')
        ?.output as string,
    ) as Record<string, unknown>;
    expect(taskOutput['status']).toBe('completed');
    expect(taskOutput['result']).toEqual({
      output: 'the answer',
    });
  });

  it('returns status + error for a failed task', async () => {
    const controlled = makeControlledTool();

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_start', 'worker', '{"job":"j1"}'),
        ]),
      })
      .mockImplementationOnce(async () => {
        controlled.fail(new Error('gpu on fire'));
        await new Promise((resolve) => setTimeout(resolve, 20));
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
              'call_task',
              'task',
              JSON.stringify({
                taskId,
                action: 'result',
              }),
            ),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_1', 'acknowledged'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        controlled.tool,
      ] as const,
    }).getText();

    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const taskOutput = JSON.parse(
      thirdInput.find((m) => m.type === 'function_call_output' && m.callId === 'call_task')
        ?.output as string,
    ) as Record<string, unknown>;
    expect(taskOutput['status']).toBe('failed');
    expect(String(taskOutput['error'])).toContain('gpu on fire');
  });
});

describe('task tool — action: cancel', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('cancels a working task; the run body signal aborts; a cancellation envelope is delivered', async () => {
    let sawAbort = false;
    const cancellable = tool({
      name: 'cancellable',
      lifecycle: 'background',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      graceMs: 0,
      run: async (_params, ctx) =>
        new Promise<{
          ok: boolean;
        }>((_resolve, reject) => {
          ctx?.signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          });
        }),
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_start', 'cancellable', '{}'),
        ]),
      })
      .mockImplementationOnce(async () => {
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
              'call_task',
              'task',
              JSON.stringify({
                taskId,
                action: 'cancel',
                reason: 'no longer needed',
              }),
            ),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_1', 'cancelled it'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        cancellable,
      ] as const,
    });
    await result.getText();

    // The cancel answer confirmed.
    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const taskOutput = JSON.parse(
      thirdInput.find((m) => m.type === 'function_call_output' && m.callId === 'call_task')
        ?.output as string,
    ) as Record<string, unknown>;
    expect(taskOutput['status']).toBe('cancelled');

    // The body's signal fired.
    expect(sawAbort).toBe(true);

    // The registry recorded the cancellation.
    expect(result.getAsyncTasks()[0]?.status).toBe('cancelled');

    // The cancellation envelope reached the model on a later request.
    const allParentInputs = mockBetaResponsesSend.mock.calls
      .map((c) => c[1]?.responsesRequest?.input as unknown)
      .filter(Array.isArray);
    const sawEnvelope = allParentInputs.some((input) =>
      (
        input as Array<{
          role?: string;
          content?: string;
        }>
      ).some(
        (m) =>
          m.role === 'user' &&
          m.content?.includes('tool_task_result') &&
          m.content?.includes('"status":"cancelled"'),
      ),
    );
    expect(sawEnvelope).toBe(true);
  });

  it('reports not_cancellable for an already-settled task', async () => {
    const controlled = makeControlledTool();

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_start', 'worker', '{"job":"j1"}'),
        ]),
      })
      .mockImplementationOnce(async () => {
        controlled.release({
          output: 'already done',
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
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
              'call_task',
              'task',
              JSON.stringify({
                taskId,
                action: 'cancel',
              }),
            ),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_1', 'ok'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        controlled.tool,
      ] as const,
    }).getText();

    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const taskOutput = JSON.parse(
      thirdInput.find((m) => m.type === 'function_call_output' && m.callId === 'call_task')
        ?.output as string,
    ) as Record<string, unknown>;
    expect(taskOutput['error']).toBe('not_cancellable');
    expect(String(taskOutput['hint'])).toContain('settled');
  });
});

describe('task tool — input validation & error paths', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('invalid action enum yields an error output; the loop continues', async () => {
    const controlled = makeControlledTool();
    const result = await driveTaskCall(controlled, (taskId) => ({
      taskId,
      action: 'explode',
    }));
    // Zod validation failure surfaces as a tool error, not a thrown run error.
    expect(result['error']).toBeDefined();
  });

  it('custom params failing the owning tool check.schema yields an error output', async () => {
    let release: ((value: { ok: boolean }) => void) | undefined;
    const gate = new Promise<{
      ok: boolean;
    }>((resolve) => {
      release = resolve;
    });
    const strict = tool({
      name: 'strict_worker',
      lifecycle: 'background',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      graceMs: 0,
      check: {
        schema: z.object({
          depth: z.number(),
        }),
        execute: async (params) => ({
          gotDepth: params['depth'],
        }),
      },
      run: async () => gate,
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_start', 'strict_worker', '{}'),
        ]),
      })
      .mockImplementationOnce(async () => {
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
              'call_task',
              'task',
              JSON.stringify({
                taskId,
                params: {
                  depth: 'not-a-number',
                },
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
        strict,
      ] as const,
    }).getText();

    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const taskOutput = thirdInput.find(
      (m) => m.type === 'function_call_output' && m.callId === 'call_task',
    );
    expect(taskOutput?.output).toContain('error');
    expect(taskOutput?.output).not.toContain('gotDepth');
  });

  it('a throwing custom check.execute yields an error output; the loop continues', async () => {
    let release: ((value: { ok: boolean }) => void) | undefined;
    const gate = new Promise<{
      ok: boolean;
    }>((resolve) => {
      release = resolve;
    });
    const throwing = tool({
      name: 'throwing_check',
      lifecycle: 'background',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      graceMs: 0,
      check: {
        execute: async () => {
          throw new Error('check handler blew up');
        },
      },
      run: async () => gate,
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_start', 'throwing_check', '{}'),
        ]),
      })
      .mockImplementationOnce(async () => {
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
              'call_task',
              'task',
              JSON.stringify({
                taskId,
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

    const text = await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        throwing,
      ] as const,
    }).getText();

    // Run completed despite the throwing handler.
    expect(text).toBeTruthy();
    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const taskOutput = thirdInput.find(
      (m) => m.type === 'function_call_output' && m.callId === 'call_task',
    );
    expect(taskOutput?.output).toContain('check handler blew up');
  });
});

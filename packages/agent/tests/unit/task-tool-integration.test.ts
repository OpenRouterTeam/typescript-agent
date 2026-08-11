import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { BuiltinTaskToolEvent, ConversationState, StateAccessor } from '../../src/index.js';
import { isToolResultEvent } from '../../src/index.js';
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

function makeGatedTool(name: string) {
  let release: ((value: { output: string }) => void) | undefined;
  const gate = new Promise<{
    output: string;
  }>((resolve) => {
    release = resolve;
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
    run: async function* () {
      yield {
        step: `${name} running`,
      };
      return await gate;
    },
  });
  return {
    tool: built,
    release: (value: { output: string }) => release?.(value),
  };
}

/** Read the placeholder-advertised taskId for a call from request N's input. */
function taskIdFromPlaceholder(requestIndex: number, callId: string): string {
  const input = mockBetaResponsesSend.mock.calls[requestIndex]?.[1]?.responsesRequest
    ?.input as Array<{
    type?: string;
    callId?: string;
    output?: string;
  }>;
  const placeholder = input.find((m) => m.type === 'function_call_output' && m.callId === callId);
  return (
    JSON.parse(placeholder?.output ?? '{}') as {
      taskId: string;
    }
  ).taskId;
}

describe('task tool — mixed rounds & multiple tasks', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('a round mixing a task-tool check, a sync tool, and a new background start executes all three', async () => {
    const workerA = makeGatedTool('worker_a');
    const workerB = makeGatedTool('worker_b');
    const syncTool = tool({
      name: 'lookup',
      inputSchema: z.object({
        key: z.string(),
      }),
      run: async ({ key }) => ({
        value: `v:${key}`,
      }),
    });

    mockBetaResponsesSend
      // Turn 1: start worker_a.
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_a', 'worker_a', '{"job":"a"}'),
        ]),
      })
      // Turn 2: MIXED round — check worker_a, call sync tool, start worker_b.
      .mockImplementationOnce(async () => {
        const taskId = taskIdFromPlaceholder(1, 'call_a');
        return {
          ok: true,
          value: makeResponse('resp_2', [
            functionCallItem(
              'call_check',
              'task',
              JSON.stringify({
                taskId,
              }),
            ),
            functionCallItem('call_sync', 'lookup', '{"key":"k1"}'),
            functionCallItem('call_b', 'worker_b', '{"job":"b"}'),
          ]),
        };
      })
      // Turn 3: settle both workers, finish.
      .mockImplementationOnce(async () => {
        workerA.release({
          output: 'A done',
        });
        workerB.release({
          output: 'B done',
        });
        return {
          ok: true,
          value: makeResponse('resp_3', [
            messageItem('msg_1', 'all running'),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_4', [
          messageItem('msg_2', 'final'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'do everything',
      tools: [
        workerA.tool,
        workerB.tool,
        syncTool,
      ] as const,
      asyncTools: {
        drainTimeoutMs: 5_000,
      },
    });

    await result.getText();

    // The mixed round produced all three outputs in call order.
    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const roundCallIds = new Set([
      'call_check',
      'call_sync',
      'call_b',
    ]);
    const outputs = thirdInput.filter(
      (m) => m.type === 'function_call_output' && roundCallIds.has(m.callId ?? ''),
    );
    const byCall = new Map(
      outputs.map((o) => [
        o.callId,
        o.output,
      ]),
    );

    expect(byCall.get('call_check')).toContain('"status":"working"');
    expect(byCall.get('call_sync')).toContain('v:k1');
    expect(byCall.get('call_b')).toContain('"status":"pending"'); // new task placeholder
    // Output order preserved: check, sync, new start.
    expect(outputs.map((o) => o.callId)).toEqual([
      'call_check',
      'call_sync',
      'call_b',
    ]);

    // Both tasks tracked, both eventually completed.
    const tasks = result.getAsyncTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === 'completed')).toBe(true);
  });

  it('two parallel task-tool checks against different tasks answer independently', async () => {
    const workerA = makeGatedTool('worker_a');
    const workerB = makeGatedTool('worker_b');

    mockBetaResponsesSend
      // Turn 1: start both.
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_a', 'worker_a', '{"job":"a"}'),
          functionCallItem('call_b', 'worker_b', '{"job":"b"}'),
        ]),
      })
      // Turn 2: check both in one round.
      .mockImplementationOnce(async () => {
        const taskA = taskIdFromPlaceholder(1, 'call_a');
        const taskB = taskIdFromPlaceholder(1, 'call_b');
        return {
          ok: true,
          value: makeResponse('resp_2', [
            functionCallItem(
              'check_a',
              'task',
              JSON.stringify({
                taskId: taskA,
              }),
            ),
            functionCallItem(
              'check_b',
              'task',
              JSON.stringify({
                taskId: taskB,
              }),
            ),
          ]),
        };
      })
      .mockImplementationOnce(async () => {
        workerA.release({
          output: 'A',
        });
        workerB.release({
          output: 'B',
        });
        return {
          ok: true,
          value: makeResponse('resp_3', [
            messageItem('msg_1', 'both checked'),
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
      input: 'start both',
      tools: [
        workerA.tool,
        workerB.tool,
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
    const checkA = JSON.parse(
      thirdInput.find((m) => m.type === 'function_call_output' && m.callId === 'check_a')
        ?.output as string,
    ) as Record<string, unknown>;
    const checkB = JSON.parse(
      thirdInput.find((m) => m.type === 'function_call_output' && m.callId === 'check_b')
        ?.output as string,
    ) as Record<string, unknown>;
    expect(checkA['toolName']).toBe('worker_a');
    expect(checkB['toolName']).toBe('worker_b');
    expect(checkA['taskId']).not.toBe(checkB['taskId']);
  });
});

describe('task tool — events & state persistence', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it("task-tool answers emit tool.result events on the stream (source 'client')", async () => {
    const worker = makeGatedTool('worker');

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_a', 'worker', '{"job":"a"}'),
        ]),
      })
      .mockImplementationOnce(async () => {
        const taskId = taskIdFromPlaceholder(1, 'call_a');
        return {
          ok: true,
          value: makeResponse('resp_2', [
            functionCallItem(
              'call_check',
              'task',
              JSON.stringify({
                taskId,
                view: 'logs',
              }),
            ),
          ]),
        };
      })
      .mockImplementationOnce(async () => {
        worker.release({
          output: 'done',
        });
        return {
          ok: true,
          value: makeResponse('resp_3', [
            messageItem('msg_1', 'working'),
          ]),
        };
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_4', [
          messageItem('msg_2', 'final'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        worker.tool,
      ] as const,
      asyncTools: {
        drainTimeoutMs: 5_000,
      },
    });

    const toolResults: BuiltinTaskToolEvent[] = [];
    for await (const event of result.getFullResponsesStream()) {
      if (isToolResultEvent(event) && event.toolName === 'task') {
        toolResults.push(event);
      }
    }

    const checkEvent = toolResults.find((e) => e.toolCallId === 'call_check');
    expect(checkEvent).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_check',
      toolName: 'task',
      source: 'client',
      result: {
        status: 'working',
        logs: expect.any(Array),
      },
    });
  });

  it('task-tool call/output pairs persist into conversation state history', async () => {
    const worker = makeGatedTool('worker');
    const { accessor, get } = createMemoryAccessor();

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_a', 'worker', '{"job":"a"}'),
        ]),
      })
      .mockImplementationOnce(async () => {
        const taskId = taskIdFromPlaceholder(1, 'call_a');
        return {
          ok: true,
          value: makeResponse('resp_2', [
            functionCallItem(
              'call_check',
              'task',
              JSON.stringify({
                taskId,
              }),
            ),
          ]),
        };
      })
      .mockImplementationOnce(async () => {
        worker.release({
          output: 'done',
        });
        return {
          ok: true,
          value: makeResponse('resp_3', [
            messageItem('msg_1', 'ok'),
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
        worker.tool,
      ] as const,
      state: accessor,
      asyncTools: {
        drainTimeoutMs: 5_000,
      },
    }).getText();

    // History carries the task function_call AND its paired output — a
    // resumed conversation must not 400 on a dangling call.
    const messages = get()?.messages as Array<{
      type?: string;
      name?: string;
      callId?: string;
    }>;
    const taskCall = messages.find((m) => m.type === 'function_call' && m.name === 'task');
    const taskOutput = messages.find(
      (m) => m.type === 'function_call_output' && m.callId === 'call_check',
    );
    expect(taskCall).toBeDefined();
    expect(taskOutput).toBeDefined();

    // JSON round-trip of the whole state stays valid.
    const roundTripped = JSON.parse(JSON.stringify(get())) as ConversationState;
    expect(roundTripped.status).toBe('complete');
  });

  it('lastLog survives a restart: post-restart check on a deferred task shows the last progress', async () => {
    const deferredWithLogs = tool({
      name: 'external_pipeline',
      lifecycle: 'deferred',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      run: async (_params, ctx) => {
        if (!ctx) {
          throw new Error('no ctx');
        }
        ctx.log('validated inputs');
        ctx.log('submitted to external queue');
        return ctx.defer('pipe_1');
      },
    });

    const { accessor } = createMemoryAccessor();

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        functionCallItem('call_d', 'external_pipeline', '{}'),
      ]),
    });
    await callModel(client, {
      model: 'test-model',
      input: 'start pipeline',
      tools: [
        deferredWithLogs,
      ] as const,
      state: accessor,
    }).getState();
    mockBetaResponsesSend.mockReset();

    // Fresh process: model checks the task.
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          functionCallItem('call_check', 'task', '{"taskId":"pipe_1"}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_1', 'still going'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'status?',
      tools: [
        deferredWithLogs,
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
    expect(checkOutput['lastLog']).toBe('submitted to external queue');
  });
});

describe('task tool — agent-tool interop', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('task steer action injects a user message into an agent child conversation', async () => {
    const childEcho = tool({
      name: 'echo',
      inputSchema: z.object({
        text: z.string(),
      }),
      execute: async ({ text }) => ({
        echoed: text,
      }),
    });

    const researcher = tool.agent({
      name: 'research',
      inputSchema: z.object({
        topic: z.string(),
      }),
      outputSchema: z.object({
        text: z.string(),
      }),
      graceMs: 0,
      agent: ({ topic }) => ({
        model: 'child-model',
        input: `Research: ${topic}`,
        tools: [
          childEcho,
        ] as const,
      }),
    });

    let childCalls = 0;
    let steered = false;
    let releaseChild: (() => void) | undefined;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    mockBetaResponsesSend.mockImplementation(
      async (
        _c: unknown,
        args: {
          responsesRequest: {
            model: string;
          };
        },
      ) => {
        if (args.responsesRequest.model === 'child-model') {
          childCalls++;
          if (childCalls === 1) {
            return {
              ok: true,
              value: makeResponse('c1', [
                functionCallItem('cc1', 'echo', '{"text":"hi"}'),
              ]),
            };
          }
          if (childCalls === 2) {
            await childGate;
            // One more tool turn so the steer message flushes before the
            // child's next request.
            return {
              ok: true,
              value: makeResponse('c2', [
                functionCallItem('cc2', 'echo', '{"text":"again"}'),
              ]),
            };
          }
          return {
            ok: true,
            value: makeResponse(`c${childCalls}`, [
              messageItem('cm', 'child done'),
            ]),
          };
        }

        // Parent turns.
        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_r', 'research', '{"topic":"x"}'),
            ]),
          };
        }
        if (parentCall === 2) {
          const input = mockBetaResponsesSend.mock.calls.filter(
            (c) => c[1]?.responsesRequest?.model === 'parent-model',
          )[1]?.[1]?.responsesRequest?.input as Array<{
            type?: string;
            callId?: string;
            output?: string;
          }>;
          const placeholder = input.find(
            (m) => m.type === 'function_call_output' && m.callId === 'call_r',
          );
          const taskId = (
            JSON.parse(placeholder?.output ?? '{}') as {
              taskId: string;
            }
          ).taskId;
          // Model steers the agent through the task tool.
          setTimeout(() => {
            steered = true;
            releaseChild?.();
          }, 30);
          return {
            ok: true,
            value: makeResponse('p2', [
              functionCallItem(
                'call_steer',
                'task',
                JSON.stringify({
                  taskId,
                  action: 'steer',
                  message: 'narrow the scope',
                }),
              ),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'done'),
          ]),
        };
      },
    );

    await callModel(client, {
      model: 'parent-model',
      input: 'research x',
      tools: [
        researcher,
      ] as const,
      asyncTools: {
        drainTimeoutMs: 10_000,
      },
    }).getText();

    // The steer answer confirmed.
    const parentInputs = mockBetaResponsesSend.mock.calls
      .filter((c) => c[1]?.responsesRequest?.model === 'parent-model')
      .map((c) => c[1]?.responsesRequest?.input as unknown);
    const sawSteerConfirm = parentInputs.some(
      (input) =>
        Array.isArray(input) &&
        input.some(
          (m: { callId?: string; output?: string }) =>
            m.callId === 'call_steer' && m.output?.includes('"steered":true'),
        ),
    );
    expect(sawSteerConfirm).toBe(true);

    // The steer message landed in a child request as a user message.
    const childInputs = mockBetaResponsesSend.mock.calls
      .filter((c) => c[1]?.responsesRequest?.model === 'child-model')
      .map((c) => c[1]?.responsesRequest?.input as unknown);
    const sawSteerInChild = childInputs.some(
      (input) =>
        Array.isArray(input) &&
        input.some(
          (m: { role?: string; content?: string }) =>
            m.role === 'user' && m.content?.includes('narrow the scope'),
        ),
    );
    expect(sawSteerInChild).toBe(true);
    void steered;
  });

  it("task transcript view on an agent task renders the child's tool activity", async () => {
    const childEcho = tool({
      name: 'echo',
      inputSchema: z.object({
        text: z.string(),
      }),
      execute: async ({ text }) => ({
        echoed: text,
      }),
    });
    const researcher = tool.agent({
      name: 'research',
      inputSchema: z.object({
        topic: z.string(),
      }),
      outputSchema: z.object({
        text: z.string(),
      }),
      graceMs: 0,
      agent: () => ({
        model: 'child-model',
        input: 'go',
        tools: [
          childEcho,
        ] as const,
      }),
    });

    let childCalls = 0;
    let releaseChild: (() => void) | undefined;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childFirstTurnDone: (() => void) | undefined;
    const childFirstTurnGate = new Promise<void>((resolve) => {
      childFirstTurnDone = resolve;
    });

    mockBetaResponsesSend.mockImplementation(
      async (
        _c: unknown,
        args: {
          responsesRequest: {
            model: string;
          };
        },
      ) => {
        if (args.responsesRequest.model === 'child-model') {
          childCalls++;
          if (childCalls === 1) {
            return {
              ok: true,
              value: makeResponse('c1', [
                functionCallItem('cc1', 'echo', '{"text":"probe"}'),
              ]),
            };
          }
          childFirstTurnDone?.();
          await childGate;
          return {
            ok: true,
            value: makeResponse('c2', [
              messageItem('cm', 'child done'),
            ]),
          };
        }

        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_r', 'research', '{"topic":"x"}'),
            ]),
          };
        }
        if (parentCall === 2) {
          await childFirstTurnGate;
          const input = mockBetaResponsesSend.mock.calls.filter(
            (c) => c[1]?.responsesRequest?.model === 'parent-model',
          )[1]?.[1]?.responsesRequest?.input as Array<{
            type?: string;
            callId?: string;
            output?: string;
          }>;
          const placeholder = input.find(
            (m) => m.type === 'function_call_output' && m.callId === 'call_r',
          );
          const taskId = (
            JSON.parse(placeholder?.output ?? '{}') as {
              taskId: string;
            }
          ).taskId;
          return {
            ok: true,
            value: makeResponse('p2', [
              functionCallItem(
                'call_t',
                'task',
                JSON.stringify({
                  taskId,
                  view: 'transcript',
                }),
              ),
            ]),
          };
        }
        releaseChild?.();
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'done'),
          ]),
        };
      },
    );

    await callModel(client, {
      model: 'parent-model',
      input: 'research x',
      tools: [
        researcher,
      ] as const,
      asyncTools: {
        drainTimeoutMs: 10_000,
      },
    }).getText();

    const parentInputs = mockBetaResponsesSend.mock.calls
      .filter((c) => c[1]?.responsesRequest?.model === 'parent-model')
      .map((c) => c[1]?.responsesRequest?.input as unknown);
    const transcriptAnswer = parentInputs
      .flatMap((input) => (Array.isArray(input) ? input : []))
      .find(
        (m: { type?: string; callId?: string; output?: string }) =>
          m.type === 'function_call_output' &&
          m.callId === 'call_t' &&
          typeof m.output === 'string',
      ) as
      | {
          output: string;
        }
      | undefined;
    expect(transcriptAnswer).toBeDefined();
    const parsed = JSON.parse(transcriptAnswer?.output ?? '{}') as Record<string, unknown>;
    expect(parsed['mode']).toBe('agent');
    expect(String(parsed['transcript'])).toContain('echo');
    expect(String(parsed['transcript'])).toContain('probe');
  });
});

import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';
import {
  isToolAsyncSettledEvent,
  isToolAsyncStartedEvent,
  isToolResultEvent,
} from '../../src/lib/tool-types.js';

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

/** Background tool whose work resolves when the test says so. */
function makeControlledBackgroundTool(
  name: string,
  options?: {
    graceMs?: number;
  },
) {
  let release: ((value: { url: string }) => void) | undefined;
  const gate = new Promise<{
    url: string;
  }>((resolve) => {
    release = resolve;
  });
  const built = tool.background({
    name,
    inputSchema: z.object({
      script: z.string(),
    }),
    outputSchema: z.object({
      url: z.string(),
    }),
    ack: 'Rendering started.',
    graceMs: options?.graceMs ?? 0,
    execute: async () => gate,
  });
  return {
    tool: built,
    release: (value: { url: string }) => release?.(value),
  };
}

describe('tool.background — placeholder & delivery', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('work settling within graceMs behaves as a plain sync tool (no placeholder, no async events)', async () => {
    const fast = tool.background({
      name: 'fast_render',
      inputSchema: z.object({
        script: z.string(),
      }),
      outputSchema: z.object({
        url: z.string(),
      }),
      graceMs: 1_000,
      execute: async () => ({
        url: 'https://cdn/video.mp4',
      }),
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_b1', 'fast_render', '{"script":"hi"}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        fast,
      ] as const,
    });

    const events: Array<{
      type: string;
    }> = [];
    for await (const event of result.getFullResponsesStream()) {
      events.push(
        event as {
          type: string;
        },
      );
    }

    expect(events.some((e) => e.type === 'tool.async_started')).toBe(false);
    expect(events.some((e) => e.type === 'tool.async_settled')).toBe(false);

    const followupInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as
      | Array<{
          type?: string;
          callId?: string;
          output?: string;
        }>
      | undefined;
    const output = followupInput?.find(
      (item) => item.type === 'function_call_output' && item.callId === 'call_b1',
    );
    expect(output?.output).toContain('https://cdn/video.mp4');
    expect(output?.output).not.toContain('pending');
  });

  it('work outliving graceMs sends a placeholder, keeps the loop going, and delivers via drain', async () => {
    const controlled = makeControlledBackgroundTool('render_video');

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_bg', 'render_video', '{"script":"hi"}'),
        ]),
      })
      // Follow-up after the placeholder round: model replies with text.
      .mockImplementationOnce(async () => {
        // Settle the background work while the model "thinks".
        controlled.release({
          url: 'https://cdn/final.mp4',
        });
        return {
          ok: true,
          value: makeResponse('resp_2', [
            messageItem('msg_1', 'Still rendering, will report back.'),
          ]),
        };
      })
      // Drain turn: the model incorporates the delivered result.
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_2', 'Here is your video: https://cdn/final.mp4'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        controlled.tool,
      ] as const,
      asyncTools: {
        onRunEnd: 'drain',
        drainTimeoutMs: 5_000,
      },
    });

    const text = await result.getText();
    expect(text).toContain('https://cdn/final.mp4');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);

    // Request 2 carried the pending placeholder.
    const secondInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const placeholder = secondInput.find(
      (item) => item.type === 'function_call_output' && item.callId === 'call_bg',
    );
    expect(placeholder?.output).toContain('"status":"pending"');
    expect(placeholder?.output).toContain('Rendering started.');

    // Request 3 (drain turn) carried the envelope as a user message —
    // never a second function_call_output for the same callId.
    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      role?: string;
      content?: string;
      callId?: string;
    }>;
    const envelope = thirdInput.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope?.content).toContain('https://cdn/final.mp4');
    const outputsForCall = thirdInput.filter(
      (m) => m.type === 'function_call_output' && m.callId === 'call_bg',
    );
    expect(outputsForCall).toHaveLength(1);
  });

  it('emits tool.async_started and tool.async_settled events, and tool.result exactly once with the final value', async () => {
    const controlled = makeControlledBackgroundTool('render_video');

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_bg', 'render_video', '{"script":"hi"}'),
        ]),
      })
      .mockImplementationOnce(async () => {
        controlled.release({
          url: 'https://cdn/final.mp4',
        });
        return {
          ok: true,
          value: makeResponse('resp_2', [
            messageItem('msg_1', 'working on it'),
          ]),
        };
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_2', 'done'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        controlled.tool,
      ] as const,
    });

    const started: unknown[] = [];
    const settled: unknown[] = [];
    const toolResults: unknown[] = [];
    for await (const event of result.getFullResponsesStream()) {
      if (isToolAsyncStartedEvent(event)) {
        started.push(event);
      }
      if (isToolAsyncSettledEvent(event)) {
        settled.push(event);
      }
      if (isToolResultEvent(event)) {
        toolResults.push(event);
      }
    }

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      toolCallId: 'call_bg',
      toolName: 'render_video',
      mode: 'background',
    });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      toolCallId: 'call_bg',
      status: 'completed',
      delivery: 'injected',
    });
    // tool.result fires exactly once, with the FINAL value.
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolCallId: 'call_bg',
      result: {
        url: 'https://cdn/final.mp4',
      },
    });
  });

  it('a failing background task delivers an error envelope (the run does not fail)', async () => {
    const failing = tool.background({
      name: 'flaky_render',
      inputSchema: z.object({}),
      outputSchema: z.object({
        url: z.string(),
      }),
      graceMs: 0,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('render farm exploded');
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_f', 'flaky_render', '{}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'started'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_2', 'the render failed'),
        ]),
      });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        failing,
      ] as const,
    }).getText();

    expect(text).toBe('the render failed');
    const thirdInput = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input as Array<{
      role?: string;
      content?: string;
    }>;
    const envelope = thirdInput.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope?.content).toContain('"status":"failed"');
    expect(envelope?.content).toContain('render farm exploded');
  });

  it("onRunEnd: 'detach' returns without waiting and drops the result", async () => {
    const controlled = makeControlledBackgroundTool('render_video');

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_bg', 'render_video', '{"script":"hi"}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'kicked off'),
        ]),
      });

    const start = Date.now();
    const result = callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        controlled.tool,
      ] as const,
      asyncTools: {
        onRunEnd: 'detach',
      },
    });

    const text = await result.getText();
    expect(text).toBe('kicked off');
    // Never waited for the (still-unsettled) task.
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);

    const tasks = result.getAsyncTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('working');

    controlled.release({
      url: 'late',
    }); // no crash; result dropped
  });

  it("onRunEnd: 'cancel' aborts in-flight background work", async () => {
    let sawAbort = false;
    const cancellable = tool.background({
      name: 'cancellable',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      graceMs: 0,
      execute: async (_params, ctx) => {
        await new Promise<void>((resolve) => {
          ctx?.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          });
        });
        throw new Error('cancelled');
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_c', 'cancellable', '{}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'started'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        cancellable,
      ] as const,
      asyncTools: {
        onRunEnd: 'cancel',
      },
    }).getResponse();

    // Give the abort microtask a beat.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sawAbort).toBe(true);
  });

  it('cancelTask(taskId) cancels a working background task', async () => {
    const controlled = makeControlledBackgroundTool('render_video');

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_bg', 'render_video', '{"script":"hi"}'),
        ]),
      })
      .mockImplementationOnce(async () => {
        return {
          ok: true,
          value: makeResponse('resp_2', [
            messageItem('msg_1', 'working'),
          ]),
        };
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_3', [
          messageItem('msg_2', 'acknowledged the cancellation'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'render',
      tools: [
        controlled.tool,
      ] as const,
    });

    // Kick off the run, then cancel the task once it appears.
    const textPromise = result.getText();
    const cancelled = await vi.waitFor(() => {
      const tasks = result.getAsyncTasks();
      const task = tasks.find((t) => t.status === 'working');
      if (!task) {
        throw new Error('task not started yet');
      }
      return result.cancelTask(task.taskId, 'user changed their mind');
    });
    expect(cancelled).toBe(true);

    const text = await textPromise;
    expect(text).toBe('acknowledged the cancellation');

    // The cancellation envelope reached the model.
    const lastInput = mockBetaResponsesSend.mock.calls.at(-1)?.[1]?.responsesRequest
      ?.input as Array<{
      role?: string;
      content?: string;
    }>;
    const envelope = lastInput.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope?.content).toContain('"status":"cancelled"');
    expect(envelope?.content).toContain('user changed their mind');
  });

  it('ctx.progress() surfaces as tool.preliminary_result events', async () => {
    const progressing = tool.background({
      name: 'progressing',
      inputSchema: z.object({}),
      eventSchema: z.object({
        pct: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      graceMs: 1_000, // settles in-window; progress still streams
      execute: async (_params, ctx) => {
        ctx?.progress({
          pct: 50,
        });
        ctx?.progress({
          pct: 100,
        });
        return {
          ok: true,
        };
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_p', 'progressing', '{}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        progressing,
      ] as const,
    });

    const progress: unknown[] = [];
    for await (const event of result.getFullResponsesStream()) {
      if (event.type === 'tool.preliminary_result') {
        progress.push(
          (
            event as {
              result: unknown;
            }
          ).result,
        );
      }
    }
    expect(progress).toEqual([
      {
        pct: 50,
      },
      {
        pct: 100,
      },
    ]);
  });
});

import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';
import { ToolTask } from '../../src/lib/tool-task.js';

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

describe('ToolTask inbox', () => {
  it('delivers immediately when a handler is registered', () => {
    const task = new ToolTask({
      taskId: 't1',
      callId: 'c1',
      toolName: 'x',
      mode: 'background',
    });
    const received: unknown[] = [];
    task.onMessage((msg) => received.push(msg));
    task.send('hello');
    expect(received).toEqual([
      'hello',
    ]);
  });

  it('queues messages sent before registration and flushes in order', () => {
    const task = new ToolTask({
      taskId: 't1',
      callId: 'c1',
      toolName: 'x',
      mode: 'background',
    });
    task.send('first');
    task.send('second');
    const received: unknown[] = [];
    task.onMessage((msg) => received.push(msg));
    expect(received).toEqual([
      'first',
      'second',
    ]);
    task.send('third');
    expect(received).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});

describe('ModelResult.sendToTask', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('delivers a message into a running background run body', async () => {
    const received: unknown[] = [];
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
      run: async (_params, ctx) => {
        ctx?.onMessage((msg) => received.push(msg));
        return gate;
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_s', 'steerable', '{}'),
        ]),
      })
      .mockResolvedValue({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        steerable,
      ] as const,
      asyncTools: {
        drainTimeoutMs: 5_000,
      },
    });

    const textPromise = result.getText();
    await vi.waitFor(() => {
      const task = result.getAsyncTasks().find((t) => t.status === 'working');
      if (!task) {
        throw new Error('task not started');
      }
      const sent = result.sendToTask(task.taskId, 'prioritize accuracy');
      expect(sent).toBe(true);
    });
    // Only settle the work AFTER the steering message landed.
    release?.({
      ok: true,
    });
    await textPromise;

    expect(received).toEqual([
      'prioritize accuracy',
    ]);
  });

  it('returns false for unknown task ids', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        messageItem('msg_1', 'no tools'),
      ]),
    });
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        tool({
          name: 'noop',
          lifecycle: 'background',
          inputSchema: z.object({}),
          outputSchema: z.object({
            ok: z.boolean(),
          }),
          run: async () => ({
            ok: true,
          }),
        }),
      ] as const,
    });
    await result.getText();
    expect(result.sendToTask('task_nope', 'hello')).toBe(false);
  });
});

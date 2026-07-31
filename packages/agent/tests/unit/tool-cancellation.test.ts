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

// dispatchRequestOptions reads client._options.timeoutMs when a run signal
// is present — the mock client must carry it.
const client = {
  _options: {},
} as OpenRouterCore;

describe('tool cancellation & timeouts (per-tool signal + timeoutMs)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('passes an unaborted ctx.signal to tool execute by default', async () => {
    let seenSignal: AbortSignal | undefined;
    let seenCallId: string | undefined;
    const probe = tool({
      name: 'probe',
      inputSchema: z.object({}),
      execute: async (_params, ctx) => {
        seenSignal = ctx?.signal;
        seenCallId = ctx?.callId;
        return {
          ok: true,
        };
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_1', 'probe', '{}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        probe,
      ] as const,
    }).getResponse();

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
    expect(seenCallId).toBe('call_1');
  });

  it('per-tool timeoutMs produces a tool_timeout error output and the loop continues', async () => {
    let toolSignalAborted = false;
    const slow = tool({
      name: 'slow',
      inputSchema: z.object({}),
      timeoutMs: 30,
      execute: async (_params, ctx) => {
        await new Promise<void>((resolve) => {
          // Body honors its signal only to record the abort — it never
          // resolves in time either way.
          ctx?.signal.addEventListener('abort', () => {
            toolSignalAborted = true;
            resolve();
          });
          setTimeout(resolve, 5_000).unref();
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
          functionCallItem('call_slow', 'slow', '{}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    const start = Date.now();
    const response = await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        slow,
      ] as const,
    }).getResponse();
    const elapsed = Date.now() - start;

    expect(response.id).toBe('resp_2');
    // The round waited ~the timeout, not the 5s body.
    expect(elapsed).toBeLessThan(2_000);
    expect(toolSignalAborted).toBe(true);

    // The follow-up request carried the timeout error output.
    const followupInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as
      | Array<{
          type?: string;
          callId?: string;
          output?: string;
        }>
      | undefined;
    const timeoutOutput = followupInput?.find(
      (item) => item.type === 'function_call_output' && item.callId === 'call_slow',
    );
    expect(timeoutOutput?.output).toContain('timed out after 30ms');
  });

  it('run-level toolTimeoutMs applies as the default; tool-level overrides it', async () => {
    const executionLog: string[] = [];
    const fast = tool({
      name: 'fast',
      inputSchema: z.object({}),
      // Overrides the (tighter) run default — this one gets 10s.
      timeoutMs: 10_000,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        executionLog.push('fast completed');
        return {
          ok: true,
        };
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('call_fast', 'fast', '{}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        fast,
      ] as const,
      toolTimeoutMs: 30, // run default would have killed the 60ms tool
    }).getResponse();

    // Tool-level 10s override won: the tool completed.
    expect(executionLog).toEqual([
      'fast completed',
    ]);
    const followupInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as
      | Array<{
          type?: string;
          callId?: string;
          output?: string;
        }>
      | undefined;
    const output = followupInput?.find(
      (item) => item.type === 'function_call_output' && item.callId === 'call_fast',
    );
    expect(output?.output).toContain('"ok":true');
  });

  it('aborting the run signal mid-round aborts the tool ctx.signal', async () => {
    const controller = new AbortController();
    let toolSawAbort = false;

    const waiting = tool({
      name: 'waiting',
      inputSchema: z.object({}),
      execute: async (_params, ctx) => {
        // Abort the RUN once the tool is in flight.
        setTimeout(() => controller.abort(new Error('user cancelled')), 20);
        await new Promise<void>((resolve) => {
          ctx?.signal.addEventListener('abort', () => {
            toolSawAbort = true;
            resolve();
          });
        });
        throw new Error('aborted');
      },
    });

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        functionCallItem('call_w', 'waiting', '{}'),
      ]),
    });

    await expect(
      callModel(client, {
        model: 'test-model',
        input: 'go',
        tools: [
          waiting,
        ] as const,
        signal: controller.signal,
      }).getResponse(),
    ).rejects.toThrow();

    expect(toolSawAbort).toBe(true);
  });

  it('ModelResult.cancel() aborts in-flight tool signals', async () => {
    let toolSawAbort = false;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });

    const hanging = tool({
      name: 'hanging',
      inputSchema: z.object({}),
      execute: async (_params, ctx) => {
        started?.();
        await new Promise<void>((resolve) => {
          ctx?.signal.addEventListener('abort', () => {
            toolSawAbort = true;
            resolve();
          });
        });
        throw new Error('cancelled');
      },
    });

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_1', [
        functionCallItem('call_h', 'hanging', '{}'),
      ]),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        hanging,
      ] as const,
    });

    const responsePromise = result.getResponse().catch(() => undefined);
    await startedPromise;
    await result.cancel();
    await responsePromise;

    expect(toolSawAbort).toBe(true);
  });
});

describe('tool concurrency controls', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  function makeCountingTool(
    name: string,
    activeCounter: {
      active: number;
      peak: number;
    },
  ) {
    return tool({
      name,
      inputSchema: z.object({
        id: z.number(),
      }),
      execute: async ({ id }) => {
        activeCounter.active++;
        activeCounter.peak = Math.max(activeCounter.peak, activeCounter.active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCounter.active--;
        return {
          id,
        };
      },
    });
  }

  it('toolConcurrency.round caps simultaneous executions within a round', async () => {
    const counter = {
      active: 0,
      peak: 0,
    };
    const counting = makeCountingTool('counting', counter);

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('c1', 'counting', '{"id":1}'),
          functionCallItem('c2', 'counting', '{"id":2}'),
          functionCallItem('c3', 'counting', '{"id":3}'),
          functionCallItem('c4', 'counting', '{"id":4}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        counting,
      ] as const,
      toolConcurrency: 2,
    }).getResponse();

    expect(counter.peak).toBe(2);
  });

  it('unbounded by default (all calls run at once)', async () => {
    const counter = {
      active: 0,
      peak: 0,
    };
    const counting = makeCountingTool('counting', counter);

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('c1', 'counting', '{"id":1}'),
          functionCallItem('c2', 'counting', '{"id":2}'),
          functionCallItem('c3', 'counting', '{"id":3}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        counting,
      ] as const,
    }).getResponse();

    expect(counter.peak).toBe(3);
  });

  it('per-tool maxConcurrency caps one tool independently and preserves output order', async () => {
    const counter = {
      active: 0,
      peak: 0,
    };
    const limited = tool({
      name: 'limited',
      inputSchema: z.object({
        id: z.number(),
      }),
      maxConcurrency: 1,
      execute: async ({ id }) => {
        counter.active++;
        counter.peak = Math.max(counter.peak, counter.active);
        // Later calls finish faster — completion order inverts call order.
        await new Promise((resolve) => setTimeout(resolve, 30 - id * 10));
        counter.active--;
        return {
          id,
        };
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('c1', 'limited', '{"id":1}'),
          functionCallItem('c2', 'limited', '{"id":2}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        limited,
      ] as const,
    }).getResponse();

    expect(counter.peak).toBe(1);

    // Output order matches call order regardless of completion order.
    const followupInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input as
      | Array<{
          type?: string;
          callId?: string;
        }>
      | undefined;
    const outputs = (followupInput ?? []).filter((item) => item.type === 'function_call_output');
    expect(outputs.map((o) => o.callId)).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('semaphore releases on tool throw (later calls still run)', async () => {
    let secondRan = false;
    const flaky = tool({
      name: 'flaky',
      inputSchema: z.object({
        id: z.number(),
      }),
      maxConcurrency: 1,
      execute: async ({ id }) => {
        if (id === 1) {
          throw new Error('boom');
        }
        secondRan = true;
        return {
          id,
        };
      },
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_1', [
          functionCallItem('c1', 'flaky', '{"id":1}'),
          functionCallItem('c2', 'flaky', '{"id":2}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_2', [
          messageItem('msg_1', 'done'),
        ]),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        flaky,
      ] as const,
    }).getResponse();

    expect(secondRan).toBe(true);
  });
});

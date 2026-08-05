/**
 * Tests for the pull-based usage accessor on ModelResult (`getUsage()`).
 *
 * Issue #10: with `getItemsStream()` and multi-round tool-calling runs,
 * per-round usage is unreachable — `getResponse()` returns only the final
 * round's response, so the `tool_calls` generations' tokens are lost.
 *
 * Covers:
 * - totals summed across every round of a multi-round tool loop
 * - the accessor works WITHOUT hooks configured (pull-based, not hook-driven)
 * - the streaming path: consume getItemsStream() fully, then getUsage()
 * - agreement with the SessionEnd.totalUsage hook payload
 * - usage-less responses still counted in modelCalls, cost omitted
 * - a run paused at `awaiting_approval` reports only its pre-pause calls,
 *   including on the approval-resume path that skips executeToolsIfNeeded
 * - an approval resume whose response is a real event stream still gets its
 *   resume generation counted by a bare getUsage(), without loop side effects
 * - a totally failed run warns with the swallowed cause (never-throw ≠ silent)
 */
import type * as models from '@openrouter/sdk/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import type { OpenRouterCore } from '@openrouter/sdk/core';
import { callModel } from '../../src/inner-loop/call-model.js';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import type { SessionEndPayload } from '../../src/lib/hooks-types.js';
import { tool } from '../../src/lib/tool.js';
import type { ConversationState, StateAccessor, Tool } from '../../src/lib/tool-types.js';
import { ToolType } from '../../src/lib/tool-types.js';

afterEach(() => {
  mockBetaResponsesSend.mockReset();
  vi.restoreAllMocks();
});

function usageBlock(overrides?: Partial<models.Usage>): models.Usage {
  return {
    inputTokens: 100,
    inputTokensDetails: {
      cachedTokens: 25,
    },
    outputTokens: 50,
    outputTokensDetails: {
      reasoningTokens: 10,
    },
    totalTokens: 150,
    cost: 0.002,
    ...overrides,
  } as models.Usage;
}

function textResponse(id = 'resp_text', usage?: models.Usage | null): models.OpenResponsesResult {
  return {
    id,
    model: 'test-model-v1',
    output: [
      {
        type: 'message',
        id: `msg_${id}`,
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'hello back',
          },
        ],
        status: 'completed',
      },
    ],
    ...(usage !== null && {
      usage: usage ?? usageBlock(),
    }),
  } as unknown as models.OpenResponsesResult;
}

function toolCallResponse(
  id = 'resp_tool',
  usage?: models.Usage,
  call: {
    name: string;
    arguments: string;
  } = {
    name: 'echo',
    arguments: '{}',
  },
): models.OpenResponsesResult {
  return {
    id,
    model: 'test-model-v1',
    output: [
      {
        type: 'function_call',
        id: `out_${id}`,
        callId: `call_${id}`,
        name: call.name,
        arguments: call.arguments,
        status: 'completed',
      },
    ],
    usage: usage ?? usageBlock(),
  } as unknown as models.OpenResponsesResult;
}

function makeEchoTool() {
  return {
    type: ToolType.Function,
    function: {
      name: 'echo',
      description: 'echo',
      inputSchema: z.object({}).loose(),
      outputSchema: z.unknown(),
      execute: async () => ({
        ok: true,
      }),
    },
  };
}

/** In-memory StateAccessor so an approval pause can be resumed. */
function makeStateAccessor(): StateAccessor<readonly Tool[]> & {
  getLatest: () => ConversationState<readonly Tool[]> | null;
} {
  let state: ConversationState<readonly Tool[]> | null = null;
  return {
    load: async () => state,
    save: async (s) => {
      state = s;
    },
    getLatest: () => state,
  };
}

/** A tool whose every call pauses the run for human approval. */
const approvalTool = tool({
  name: 'risky',
  description: 'Does something that needs a human to sign off.',
  inputSchema: z.object({
    target: z.string(),
  }),
  outputSchema: z.object({
    done: z.boolean(),
  }),
  requireApproval: true,
  execute: async () => ({
    done: true,
  }),
});

/** A scripted `function_call` naming the approval-gated tool above. */
const riskyCall = {
  name: 'risky',
  arguments: JSON.stringify({
    target: 'prod',
  }),
};

const client = {} as unknown as OpenRouterCore;

describe('ModelResult.getUsage()', () => {
  it('sums usage across every round of a multi-round tool loop', async () => {
    // Round 1: tool_calls generation. Round 2: final stop generation.
    // getResponse() only exposes round 2 — this is the gap in issue #10.
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse(
          'r2',
          usageBlock({
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            cost: 0.003,
          }),
        ),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
    });

    await result.getResponse();
    const usage = await result.getUsage();

    expect(usage).toEqual({
      modelCalls: 2,
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      cachedTokens: 50,
      reasoningTokens: 20,
      cost: 0.005,
    });

    // The gap this closes: the final response alone reports only round 2.
    const finalResponse = await result.getResponse();
    expect(finalResponse.usage?.totalTokens).toBe(300);
  });

  it('awaits run completion when called without awaiting getResponse() first', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('r2'),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
    });

    // No prior await — getUsage() must gate on completion itself.
    const usage = await result.getUsage();
    expect(usage.modelCalls).toBe(2);
    expect(usage.totalTokens).toBe(300);
  });

  it('accumulates with no hooks configured (pull-based, not hook-driven)', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse('r1'),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
    });
    await result.getText();

    expect(await result.getUsage()).toEqual({
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 25,
      reasoningTokens: 10,
      cost: 0.002,
    });
  });

  it('reports complete totals after consuming getItemsStream() on a tool loop', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse(
          'r2',
          usageBlock({
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            cost: 0.003,
          }),
        ),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
    });

    for await (const _item of result.getItemsStream()) {
      // drain
    }

    expect(await result.getUsage()).toEqual({
      modelCalls: 2,
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      cachedTokens: 50,
      reasoningTokens: 20,
      cost: 0.005,
    });
  });

  it('reports complete totals after consuming the no-tools getItemsStream()', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse('r1'),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
    });

    for await (const _item of result.getItemsStream()) {
      // drain
    }

    expect(await result.getUsage()).toMatchObject({
      modelCalls: 1,
      totalTokens: 150,
    });
  });

  it('agrees with the SessionEnd.totalUsage hook payload', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('r2'),
      });

    const hooks = new HooksManager();
    const ends: SessionEndPayload[] = [];
    hooks.on('SessionEnd', {
      handler: (payload) => {
        ends.push(payload);
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
      hooks,
    });
    await result.getText();

    expect(ends).toHaveLength(1);
    expect(await result.getUsage()).toEqual(ends[0]?.totalUsage);
  });

  it('counts usage-less responses in modelCalls and omits cost', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse('r1', null),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
    });
    await result.getText();

    const usage = await result.getUsage();
    expect(usage).toMatchObject({
      modelCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
    expect(usage.cost).toBeUndefined();
  });

  it('returns zeroed totals when no model call completed, warning with the swallowed cause', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: false,
      error: new Error('api down'),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
    });
    await expect(result.getText()).rejects.toThrow('api down');

    const usage = await result.getUsage();
    expect(usage).toMatchObject({
      modelCalls: 0,
      totalTokens: 0,
    });
    expect(usage.cost).toBeUndefined();

    // Never-throws must not mean silent: the caller who only ever awaits
    // getUsage() (e.g. a cost-accounting sidecar) needs a diagnostic to
    // distinguish "the API was down" from "the run was genuinely free".
    expect(warnSpy).toHaveBeenCalledWith(
      '[getUsage] run failed; reporting totals accrued so far:',
      expect.objectContaining({
        message: 'api down',
      }),
    );
  });

  describe('paused at awaiting_approval', () => {
    it('reports only the model calls that completed before the pause', async () => {
      // One response: the model calls the approval-gated tool. The tool never
      // executes and no follow-up request is made — the run parks awaiting a
      // human decision, so exactly one model call has completed.
      mockBetaResponsesSend.mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1', undefined, riskyCall),
      });

      const accessor = makeStateAccessor();
      const result = callModel(client, {
        model: 'test-model',
        input: 'do the risky thing',
        tools: [
          approvalTool,
        ] as const,
        state: accessor,
      });

      // Drives the loop up to the approval gate (does not throw on a pause).
      await result.getPendingToolCalls();

      const paused = accessor.getLatest();
      expect(paused?.status).toBe('awaiting_approval');
      expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

      // Totals reflect the single pre-pause generation, not a zeroed or
      // speculative aggregate.
      expect(await result.getUsage()).toEqual({
        modelCalls: 1,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cachedTokens: 25,
        reasoningTokens: 10,
        cost: 0.002,
      });
    });

    it('is idempotent while paused and drives no further model requests', async () => {
      mockBetaResponsesSend.mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1', undefined, riskyCall),
      });

      const accessor = makeStateAccessor();
      const result = callModel(client, {
        model: 'test-model',
        input: 'do the risky thing',
        tools: [
          approvalTool,
        ] as const,
        state: accessor,
      });
      await result.getPendingToolCalls();
      expect(accessor.getLatest()?.status).toBe('awaiting_approval');

      // Repeated reads of a paused run must not re-drive the loop, dispatch a
      // request, or double-count the pre-pause generation. A further scripted
      // response is queued precisely so an accidental dispatch would show up
      // both as a call count bump and as inflated totals.
      mockBetaResponsesSend.mockResolvedValueOnce({
        ok: true,
        value: textResponse('should-not-be-consumed'),
      });

      const first = await result.getUsage();
      expect(first.modelCalls).toBe(1);
      expect(await result.getUsage()).toEqual(first);
      expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    });

    it('scopes totals per ModelResult across an approval resume', async () => {
      // Run 1: model calls risky(...) → parks at the approval gate.
      mockBetaResponsesSend.mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1', undefined, riskyCall),
      });

      const accessor = makeStateAccessor();
      const first = callModel(client, {
        model: 'test-model',
        input: 'do the risky thing',
        tools: [
          approvalTool,
        ] as const,
        state: accessor,
      });
      await first.getPendingToolCalls();

      const pausedCallId = accessor.getLatest()?.pendingToolCalls?.[0]?.id;
      expect(pausedCallId).toBeDefined();

      // Resume: approving the call executes the tool and the unsent-results
      // request lands one further generation (r2). This resumed ModelResult
      // carries `isResumingFromApproval`, so getUsage() skips
      // executeToolsIfNeeded() and reports straight from the aggregate.
      mockBetaResponsesSend.mockResolvedValueOnce({
        ok: true,
        value: textResponse(
          'r2',
          usageBlock({
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            cost: 0.003,
          }),
        ),
      });

      const resumed = callModel(client, {
        model: 'test-model',
        input: undefined as unknown as string,
        tools: [
          approvalTool,
        ] as const,
        state: accessor,
        approveToolCalls: [
          pausedCallId as string,
        ],
      });
      await resumed.getPendingToolCalls();

      // The aggregate is per-ModelResult, not per-conversation: the resumed
      // run reports only its OWN generation (r2). Run 1's r1 stays on `first`,
      // so a caller summing across resumes adds them rather than
      // double-counting a shared running total.
      expect(await resumed.getUsage()).toMatchObject({
        modelCalls: 1,
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 0.003,
      });
      expect(await first.getUsage()).toMatchObject({
        modelCalls: 1,
        inputTokens: 100,
        totalTokens: 150,
        cost: 0.002,
      });
    });

    it('does not advance an approval-resumed run when read before the loop', async () => {
      // Pins the `isResumingFromApproval` guard specifically. Reading usage is
      // an observation, so on a resumed run it must NOT stand in for driving
      // the loop: without the guard this call runs executeToolsIfNeeded() and
      // settles the conversation to 'complete' as a side effect of asking a
      // question. Totals alone can't catch that — the resume's generation is
      // dispatched during initStream either way — so assert on run status.
      mockBetaResponsesSend.mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1', undefined, riskyCall),
      });

      const accessor = makeStateAccessor();
      const first = callModel(client, {
        model: 'test-model',
        input: 'do the risky thing',
        tools: [
          approvalTool,
        ] as const,
        state: accessor,
      });
      await first.getPendingToolCalls();
      const pausedCallId = accessor.getLatest()?.pendingToolCalls?.[0]?.id;

      mockBetaResponsesSend.mockResolvedValueOnce({
        ok: true,
        value: textResponse('r2'),
      });

      const resumed = callModel(client, {
        model: 'test-model',
        input: undefined as unknown as string,
        tools: [
          approvalTool,
        ] as const,
        state: accessor,
        approveToolCalls: [
          pausedCallId as string,
        ],
      });

      // getUsage() is the FIRST call on the resumed run — nothing has driven
      // the loop yet.
      expect(await resumed.getUsage()).toMatchObject({
        modelCalls: 1,
      });
      expect(accessor.getLatest()?.status).toBe('in_progress');
    });

    it('counts a STREAMING resume generation without advancing the loop', async () => {
      // The resume dispatch may return a real event stream instead of a
      // non-streaming body. Its telemetry stays parked until something
      // consumes the stream — a bare getUsage() must do that consumption
      // itself (a passive buffer read) rather than under-report the resume
      // request's tokens, while still not driving the tool loop.
      mockBetaResponsesSend.mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1', undefined, riskyCall),
      });

      const accessor = makeStateAccessor();
      const first = callModel(client, {
        model: 'test-model',
        input: 'do the risky thing',
        tools: [
          approvalTool,
        ] as const,
        state: accessor,
      });
      await first.getPendingToolCalls();
      const pausedCallId = accessor.getLatest()?.pendingToolCalls?.[0]?.id;

      const resumeResponse = textResponse(
        'r2_streamed',
        usageBlock({
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          cost: 0.003,
        }),
      );
      mockBetaResponsesSend.mockResolvedValueOnce({
        ok: true,
        value: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'response.completed',
              response: resumeResponse,
              sequenceNumber: 0,
            });
            controller.close();
          },
        }),
      });

      const resumed = callModel(client, {
        model: 'test-model',
        input: undefined as unknown as string,
        tools: [
          approvalTool,
        ] as const,
        state: accessor,
        approveToolCalls: [
          pausedCallId as string,
        ],
      });

      // Bare read, nothing else has consumed the resume stream.
      expect(await resumed.getUsage()).toMatchObject({
        modelCalls: 1,
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 0.003,
      });
      // Observation only: the run has not been settled as a side effect.
      expect(accessor.getLatest()?.status).toBe('in_progress');
    });
  });
});

/**
 * Tests for the PostModelCall telemetry hook and SessionEnd usage totals,
 * driven through the public callModel surface with betaResponsesSend mocked
 * at the module level.
 *
 * Covers:
 * - one emit per model call across a tool loop (initial + tool_round)
 * - payload shape: responseId, model, turnType, turnNumber, usage mapping
 * - no-tools getText() and getTextStream() paths emit exactly once
 * - usage-less responses emit without `usage`, still counted in totals
 * - SessionEnd carries aggregated totalUsage (tokens summed, cost summed)
 * - failed initial request emits no PostModelCall and no totalUsage
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
import type { PostModelCallPayload, SessionEndPayload } from '../../src/lib/hooks-types.js';
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

function toolCallResponse(id = 'resp_tool'): models.OpenResponsesResult {
  return {
    id,
    model: 'test-model-v1',
    output: [
      {
        type: 'function_call',
        id: `out_${id}`,
        callId: `call_${id}`,
        name: 'echo',
        arguments: '{}',
        status: 'completed',
      },
    ],
    usage: usageBlock(),
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

function collectHooks() {
  const hooks = new HooksManager();
  const calls: PostModelCallPayload[] = [];
  const ends: SessionEndPayload[] = [];
  hooks.on('PostModelCall', {
    handler: (payload) => {
      calls.push(payload);
    },
  });
  hooks.on('SessionEnd', {
    handler: (payload) => {
      ends.push(payload);
    },
  });
  return {
    hooks,
    calls,
    ends,
  };
}

const client = {} as unknown as OpenRouterCore;

describe('PostModelCall hook', () => {
  it('emits once per model call across a tool loop with correct turn labels', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('r2'),
      });

    const { hooks, calls } = collectHooks();
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
      hooks,
    });
    await result.getText();

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      responseId: 'r1',
      model: 'test-model-v1',
      turnType: 'initial',
      turnNumber: 0,
    });
    expect(calls[1]).toMatchObject({
      responseId: 'r2',
      turnType: 'tool_round',
      turnNumber: 1,
    });
    expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('maps the usage block onto the payload (cached/reasoning/cost)', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse('r1'),
    });

    const { hooks, calls } = collectHooks();
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });
    await result.getText();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 25,
      reasoningTokens: 10,
      cost: 0.002,
    });
  });

  it('emits without usage when the response carries none, still counted in totals', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse('r1', null),
    });

    const { hooks, calls, ends } = collectHooks();
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });
    await result.getText();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.usage).toBeUndefined();
    expect(ends[0]?.totalUsage).toMatchObject({
      modelCalls: 1,
      totalTokens: 0,
    });
    expect(ends[0]?.totalUsage?.cost).toBeUndefined();
  });

  it('emits exactly once on the no-tools getTextStream() path', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse('r1'),
    });

    const { hooks, calls } = collectHooks();
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });
    for await (const _chunk of result.getTextStream()) {
      // drain
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      responseId: 'r1',
      turnType: 'initial',
    });
  });

  it('aggregates totalUsage on SessionEnd across all calls', async () => {
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

    const { hooks, ends } = collectHooks();
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
    expect(ends[0]?.totalUsage).toEqual({
      modelCalls: 2,
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      cachedTokens: 50,
      reasoningTokens: 20,
      cost: 0.005,
    });
  });

  it('emits no PostModelCall and no totalUsage when the initial request fails', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: false,
      error: new Error('api down'),
    });

    const { hooks, calls, ends } = collectHooks();
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });
    await expect(result.getText()).rejects.toThrow('api down');

    expect(calls).toHaveLength(0);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      reason: 'error',
    });
    expect(ends[0]?.totalUsage).toBeUndefined();
  });

  it('emits on a genuinely streaming initial response (response.completed event)', async () => {
    const streamed = textResponse('r_streamed');
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'response.completed',
          response: streamed,
          sequenceNumber: 0,
        });
        controller.close();
      },
    });
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: readable,
    });

    const { hooks, calls } = collectHooks();
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });
    const text = await result.getText();

    expect(text).toBe('hello back');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      responseId: 'r_streamed',
      turnType: 'initial',
      usage: {
        totalTokens: 150,
      },
    });
  });

  it('still emits SessionEnd and drains when teardown telemetry cannot materialize', async () => {
    // A stream that ends without a completion event (deltas only, then close)
    // makes the parked-telemetry materialization in teardown throw
    // ("Stream ended without completion event"). That failure must be
    // contained: SessionEnd still fires and no PostModelCall is emitted.
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'response.output_item.added',
          item: {
            type: 'message',
            id: 'msg_partial',
            role: 'assistant',
            content: [],
            status: 'in_progress',
          },
          outputIndex: 0,
          sequenceNumber: 0,
        });
        controller.enqueue({
          type: 'response.output_text.delta',
          itemId: 'msg_partial',
          outputIndex: 0,
          contentIndex: 0,
          delta: 'partial',
          sequenceNumber: 1,
        });
        controller.close();
      },
    });
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: readable,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { hooks, calls, ends } = collectHooks();
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });
    for await (const _chunk of result.getTextStream()) {
      // drain
    }

    expect(calls).toHaveLength(0);
    expect(ends).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[PostModelCall] error during stream teardown:',
      expect.objectContaining({
        message: expect.stringContaining('without completion event'),
      }),
    );
  });
});

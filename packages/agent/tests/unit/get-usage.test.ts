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

function toolCallResponse(id = 'resp_tool', usage?: models.Usage): models.OpenResponsesResult {
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

  it('returns zeroed totals when no model call completed', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: false,
      error: new Error('api down'),
    });

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
  });
});

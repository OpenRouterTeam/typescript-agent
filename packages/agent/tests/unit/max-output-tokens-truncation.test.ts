import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';
import {
  extractToolCallsFromResponse,
  responseHasToolCalls,
} from '../../src/lib/stream-transformers.js';
import { ToolType } from '../../src/lib/tool-types.js';

/**
 * A turn the provider stopped at `max_output_tokens` two tokens into the tool
 * call: a reasoning model spent the whole budget thinking. The `function_call`
 * item is present but its arguments are a fragment. The loop must treat this
 * as the end of the run, not as a call to execute or a reason to request again.
 */
function truncatedToolCallResponse(
  output: models.OpenResponsesResult['output'] = [
    {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call_1',
      name: 'run_shell',
      arguments: '{"commands":',
      status: 'incomplete',
    },
  ],
): models.OpenResponsesResult {
  return {
    id: 'resp_truncated',
    object: 'response',
    createdAt: 1_783_462_506,
    completedAt: 1_783_462_520,
    model: 'test-model',
    status: 'incomplete',
    incompleteDetails: {
      reason: 'max_output_tokens',
    },
    error: null,
    output,
    usage: {
      inputTokens: 4529,
      inputTokensDetails: {
        cachedTokens: 0,
      },
      outputTokens: 3002,
      totalTokens: 7531,
      outputTokensDetails: {
        reasoningTokens: 3000,
      },
    },
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

/**
 * The same cut-off after a parallel batch: three weather calls completed
 * before the budget ran out inside the fourth call. The batch is one plan;
 * running the three would leave the model a result set with a silent hole.
 */
function truncatedBatchResponse(): models.OpenResponsesResult {
  return truncatedToolCallResponse([
    ...[
      'Paris',
      'London',
      'Tokyo',
    ].map((city, index) => ({
      type: 'function_call' as const,
      id: `fc_weather_${index}`,
      callId: `call_weather_${index}`,
      name: 'get_weather',
      arguments: JSON.stringify({
        city,
      }),
      status: 'completed' as const,
    })),
    {
      type: 'function_call',
      id: 'fc_shell',
      callId: 'call_shell',
      name: 'run_shell',
      arguments: '{"commands":',
      status: 'incomplete',
    },
  ]);
}

const client = {} as OpenRouterCore;

describe('max_output_tokens truncation', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('extracts no tool calls from a response truncated at max_output_tokens', () => {
    const response = truncatedToolCallResponse();

    expect(responseHasToolCalls(response)).toBe(false);
    expect(extractToolCallsFromResponse(response)).toEqual([]);
  });

  it('finalizes on the truncated turn without executing the partial call or requesting again', async () => {
    const executed: unknown[] = [];
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: truncatedToolCallResponse(),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Run echo hello.',
      // Bounds the run so a regression (re-requesting on the exhausted budget)
      // fails on the request count rather than looping until the worker dies.
      stopWhen: stepCountIs(3),
      tools: [
        {
          type: ToolType.Function,
          function: {
            name: 'run_shell',
            description: 'Run shell commands.',
            inputSchema: z.object({
              commands: z.array(z.string()),
            }),
            execute: async (params: { commands: string[] }) => {
              executed.push(params);
              return {
                ok: true,
              };
            },
          },
        },
      ] as const,
    });

    const response = await result.getResponse();

    expect(executed).toEqual([]);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    expect(response.id).toBe('resp_truncated');
    expect(response.status).toBe('incomplete');
  });

  it('does not execute the calls that completed before the cut-off either', async () => {
    const executed: unknown[] = [];
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: truncatedBatchResponse(),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Weather in three cities, then run echo hello.',
      stopWhen: stepCountIs(3),
      tools: [
        {
          type: ToolType.Function,
          function: {
            name: 'get_weather',
            description: 'Get the weather.',
            inputSchema: z.object({
              city: z.string(),
            }),
            execute: async (params: { city: string }) => {
              executed.push(params);
              return {
                temperature: 22,
              };
            },
          },
        },
        {
          type: ToolType.Function,
          function: {
            name: 'run_shell',
            description: 'Run shell commands.',
            inputSchema: z.object({
              commands: z.array(z.string()),
            }),
            execute: async (params: { commands: string[] }) => {
              executed.push(params);
              return {
                ok: true,
              };
            },
          },
        },
      ] as const,
    });

    const response = await result.getResponse();

    expect(executed).toEqual([]);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    expect(response.status).toBe('incomplete');
    // The caller gets the whole turn, cut-off item included, to resume from.
    expect(response.output.map((item) => ('callId' in item ? item.callId : item.type))).toEqual([
      'call_weather_0',
      'call_weather_1',
      'call_weather_2',
      'call_shell',
    ]);
  });
});

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
function truncatedToolCallResponse(): models.OpenResponsesResult {
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
    output: [
      {
        type: 'function_call',
        id: 'fc_1',
        callId: 'call_1',
        name: 'run_shell',
        arguments: '{"commands":',
        status: 'incomplete',
      },
    ],
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
});

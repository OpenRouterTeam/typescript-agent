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

const RESPONSE_BASE = {
  object: 'response',
  createdAt: 1_783_462_506,
  completedAt: 1_783_462_520,
  model: 'test-model',
  error: null,
  temperature: null,
  topP: null,
  presencePenalty: null,
  frequencyPenalty: null,
  metadata: null,
  instructions: null,
  tools: [],
  toolChoice: 'auto',
  parallelToolCalls: true,
} as const;

const USAGE = {
  inputTokens: 4529,
  inputTokensDetails: {
    cachedTokens: 0,
  },
  outputTokens: 3002,
  totalTokens: 7531,
  outputTokensDetails: {
    reasoningTokens: 3000,
  },
} as const;

const TRUNCATED_SHELL_CALL = {
  type: 'function_call',
  id: 'fc_shell',
  callId: 'call_shell',
  name: 'run_shell',
  arguments: '{"commands":',
  status: 'incomplete',
} as const;

const COMPLETED_WEATHER_CALL = {
  type: 'function_call',
  id: 'fc_weather',
  callId: 'call_weather',
  name: 'get_weather',
  arguments: '{"city":"Paris"}',
  status: 'completed',
} as const;

/**
 * A turn the provider stopped at `max_output_tokens` two tokens into the tool
 * call: a reasoning model spent the whole budget thinking. The `function_call`
 * item is present but its arguments are a fragment. The loop must treat this
 * as the end of the run, not as a call to execute or a reason to request again.
 */
function truncatedToolCallResponse(): models.OpenResponsesResult {
  return {
    ...RESPONSE_BASE,
    id: 'resp_truncated',
    status: 'incomplete',
    incompleteDetails: {
      reason: 'max_output_tokens',
    },
    output: [
      TRUNCATED_SHELL_CALL,
    ],
    usage: USAGE,
  } as models.OpenResponsesResult;
}

/** A parallel turn that completed one call and was cut off during the next. */
function mixedTruncatedResponse(): models.OpenResponsesResult {
  return {
    ...RESPONSE_BASE,
    id: 'resp_mixed',
    status: 'incomplete',
    incompleteDetails: {
      reason: 'max_output_tokens',
    },
    output: [
      COMPLETED_WEATHER_CALL,
      TRUNCATED_SHELL_CALL,
    ],
    usage: USAGE,
  } as models.OpenResponsesResult;
}

function textResponse(text: string): models.OpenResponsesResult {
  return {
    ...RESPONSE_BASE,
    id: 'resp_final',
    status: 'completed',
    incompleteDetails: null,
    output: [
      {
        type: 'message',
        id: 'msg_final',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text,
            annotations: [],
          },
        ],
      },
    ],
    usage: USAGE,
  } as models.OpenResponsesResult;
}

const executed: unknown[] = [];

const shellTool = {
  type: ToolType.Function,
  function: {
    name: 'run_shell',
    description: 'Run shell commands.',
    inputSchema: z.object({
      commands: z.array(z.string()),
    }),
    execute: async (params: { commands: string[] }) => {
      executed.push({
        tool: 'run_shell',
        ...params,
      });
      return {
        ok: true,
      };
    },
  },
} as const;

const weatherTool = {
  type: ToolType.Function,
  function: {
    name: 'get_weather',
    description: 'Get the weather.',
    inputSchema: z.object({
      city: z.string(),
    }),
    execute: async (params: { city: string }) => {
      executed.push({
        tool: 'get_weather',
        ...params,
      });
      return {
        temperature: 22,
      };
    },
  },
} as const;

const client = {} as OpenRouterCore;

describe('max_output_tokens truncation', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
    executed.length = 0;
  });

  it('extracts no tool calls from a response truncated before any call completed', () => {
    const response = truncatedToolCallResponse();

    expect(responseHasToolCalls(response)).toBe(false);
    expect(extractToolCallsFromResponse(response)).toEqual([]);
  });

  it('keeps the calls that completed before the cut-off and drops the truncated one', () => {
    const response = mixedTruncatedResponse();

    expect(responseHasToolCalls(response)).toBe(true);
    expect(extractToolCallsFromResponse(response)).toEqual([
      {
        id: 'call_weather',
        name: 'get_weather',
        arguments: {
          city: 'Paris',
        },
      },
    ]);
  });

  it('finalizes on the truncated turn without executing the partial call or requesting again', async () => {
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
        shellTool,
      ] as const,
    });

    const response = await result.getResponse();

    expect(executed).toEqual([]);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    expect(response.id).toBe('resp_truncated');
    expect(response.status).toBe('incomplete');
  });

  it('executes the completed call and omits the truncated one from the follow-up request', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: mixedTruncatedResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('It is 22 degrees in Paris.'),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Weather in Paris, then run echo hello.',
      stopWhen: stepCountIs(3),
      tools: [
        weatherTool,
        shellTool,
      ] as const,
    });

    const text = await result.getText();

    expect(text).toBe('It is 22 degrees in Paris.');
    expect(executed).toEqual([
      {
        tool: 'get_weather',
        city: 'Paris',
      },
    ]);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);

    const followUp = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    const input = followUp.input as {
      type?: string;
      callId?: string;
    }[];
    const functionCalls = input.filter((item) => item.type === 'function_call');
    const outputs = input.filter((item) => item.type === 'function_call_output');
    // The truncated shell call is not echoed: a call with no output would be
    // rejected by the provider, and the model never made it.
    expect(functionCalls.map((item) => item.callId)).toEqual([
      'call_weather',
    ]);
    expect(outputs.map((item) => item.callId)).toEqual([
      'call_weather',
    ]);
  });
});

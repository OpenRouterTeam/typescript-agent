import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { serverTool } from '../../src/lib/tool.js';
import { ToolType } from '../../src/lib/tool-types.js';

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

function textResponse(id: string, text: string): models.OpenResponsesResult {
  return makeResponse(id, [
    {
      id: 'msg_text',
      type: 'message',
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
  ]);
}

function customToolCallItem(
  callId: string,
  name: string,
  input: string,
): models.OutputCustomToolCallItem {
  return {
    type: 'custom_tool_call',
    id: `ctc_${callId}`,
    callId,
    name,
    input,
    status: 'completed',
  };
}

const autoTool = {
  type: ToolType.Function,
  function: {
    name: 'auto_search',
    description: 'Auto-executed tool.',
    inputSchema: z.object({
      query: z.string(),
    }),
    outputSchema: z.object({
      result: z.string(),
    }),
    execute: async (_params: { query: string }) => ({
      result: 'found it',
    }),
  },
} as const;

const sqlTool = serverTool({
  type: 'custom',
  name: 'run_sql',
  description: 'Run a SQL query.',
  format: {
    type: 'grammar',
    syntax: 'lark',
    definition: 'start: "SELECT " /[a-z]+/ ";"',
  },
});

const client = {} as OpenRouterCore;

function sentRequest(callIndex: number): models.ResponsesRequest | undefined {
  return mockBetaResponsesSend.mock.calls[callIndex]?.[1]?.responsesRequest;
}

describe('custom tool calls in the tool loop', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('sends the custom tool with its grammar and stops on a custom-only round', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_custom', [
        customToolCallItem('call_sql', 'run_sql', 'SELECT users;'),
      ]),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'select users',
      tools: [
        autoTool,
        sqlTool,
      ] as const,
    });

    const response = await result.getResponse();

    expect(response.id).toBe('resp_custom');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    expect(sentRequest(0)?.tools).toContainEqual({
      type: 'custom',
      name: 'run_sql',
      description: 'Run a SQL query.',
      format: {
        type: 'grammar',
        syntax: 'lark',
        definition: 'start: "SELECT " /[a-z]+/ ";"',
      },
    });
  });

  it('runs the auto call of a mixed round, then stops before an orphaned custom call', async () => {
    let executed = 0;
    const countingTool = {
      ...autoTool,
      function: {
        ...autoTool.function,
        execute: async (_params: { query: string }) => {
          executed++;
          return {
            result: 'found it',
          };
        },
      },
    } as const;
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeResponse('resp_mixed', [
        functionCallItem('call_auto_1', 'auto_search', '{"query":"docs"}'),
        customToolCallItem('call_sql', 'run_sql', 'SELECT users;'),
      ]),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'do both things',
      tools: [
        countingTool,
        sqlTool,
      ] as const,
    });

    const response = await result.getResponse();

    expect(response.id).toBe('resp_mixed');
    expect(executed).toBe(1);
    // A follow-up would carry run_sql's custom_tool_call with no output.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('stops when a later round returns only a custom call', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_auto', [
          functionCallItem('call_auto_1', 'auto_search', '{"query":"docs"}'),
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeResponse('resp_custom', [
          customToolCallItem('call_sql', 'run_sql', 'SELECT users;'),
        ]),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'search, then query',
      tools: [
        autoTool,
        sqlTool,
      ] as const,
    });

    const response = await result.getResponse();

    expect(response.id).toBe('resp_custom');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });
});

import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
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

// No `execute` — the client is responsible for running this tool.
const manualTool = {
  type: ToolType.Function,
  function: {
    name: 'exec_command',
    description: 'Manual client-executed tool.',
    inputSchema: z.object({
      command: z.string(),
    }),
    outputSchema: z.object({
      stdout: z.string(),
    }),
  },
} as const;

const client = {} as OpenRouterCore;

describe('mixed auto + manual tool round', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('stops the loop instead of sending a follow-up with an orphaned function_call', async () => {
    const mixedRoundResponse = makeResponse('resp_mixed', [
      functionCallItem('call_auto_1', 'auto_search', '{"query":"docs"}'),
      functionCallItem('call_manual_1', 'exec_command', '{"command":"ls"}'),
    ]);

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: mixedRoundResponse,
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'do both things',
      tools: [
        autoTool,
        manualTool,
      ] as const,
    });

    const response = await result.getResponse();

    // The response with the unresolved manual call is surfaced so the caller
    // can execute it and continue the conversation.
    expect(response.id).toBe('resp_mixed');
    // No follow-up request was made: its input would have contained
    // exec_command's function_call with no matching function_call_output,
    // which providers reject with a 400 ("No tool output found for function
    // call ...").
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('still loops when every tool call in the round resolves', async () => {
    const autoOnlyResponse = makeResponse('resp_auto', [
      functionCallItem('call_auto_1', 'auto_search', '{"query":"docs"}'),
    ]);

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: autoOnlyResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('resp_final', 'All done.'),
      });

    const result = callModel(client, {
      model: 'test-model',
      input: 'search the docs',
      tools: [
        autoTool,
        manualTool,
      ] as const,
    });

    const text = await result.getText();

    expect(text).toBe('All done.');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);

    // The follow-up request pairs the executed call with its real output.
    const followupInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest
      ?.input as unknown[];
    expect(Array.isArray(followupInput)).toBe(true);
    const fnCallOutput = followupInput.find(
      (
        i,
      ): i is {
        type: string;
        callId: string;
        output: string;
      } =>
        typeof i === 'object' &&
        i !== null &&
        (
          i as {
            type?: string;
          }
        ).type === 'function_call_output',
    );
    expect(fnCallOutput?.callId).toBe('call_auto_1');
    expect(fnCallOutput?.output).toContain('found it');
  });
});

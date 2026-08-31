import type * as models from '@openrouter/sdk/models';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import {
  executeToolLoop,
  getToolExecutionErrors,
  hasToolExecutionErrors,
  summarizeToolExecutions,
  toolResultsToMap,
} from '../../src/lib/tool-orchestrator.js';
import type { Tool, ToolExecutionResult } from '../../src/lib/tool-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function functionCallItem(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): models.OutputFunctionCallItem {
  return {
    type: 'function_call',
    callId,
    name,
    arguments: JSON.stringify(args),
    id: callId,
    status: 'completed',
  } as unknown as models.OutputFunctionCallItem;
}

function responseWith(...items: unknown[]): models.OpenResponsesResult {
  return {
    output: items,
  } as unknown as models.OpenResponsesResult;
}

function terminalResponse(): models.OpenResponsesResult {
  return responseWith({
    type: 'message',
    role: 'assistant',
    content: [],
  });
}

/**
 * A sendRequest stub that returns queued responses in order.
 */
function queueSendRequest(...responses: models.OpenResponsesResult[]) {
  let index = 0;
  return vi.fn(async (_input: models.InputsUnion, _tools: unknown[]) => {
    const response = responses[index] ?? responses[responses.length - 1];
    index++;
    if (!response) {
      throw new Error('sendRequest called with no queued responses');
    }
    return response;
  });
}

const initialRequest = {
  model: 'openai/gpt-4',
  input: [
    {
      role: 'user',
      content: 'hi',
    },
  ],
} as unknown as models.ResponsesRequest;

const initialInput = [
  {
    role: 'user',
    content: 'hi',
  },
] as unknown as models.InputsUnion;

// ---------------------------------------------------------------------------
// executeToolLoop
// ---------------------------------------------------------------------------

describe('executeToolLoop', () => {
  it('returns immediately when the initial response has no tool calls', async () => {
    const response = terminalResponse();
    const sendRequest = queueSendRequest(response);

    const result = await executeToolLoop(sendRequest, initialInput, initialRequest, [], []);

    expect(result.finalResponse).toBe(response);
    expect(result.allResponses).toEqual([
      response,
    ]);
    expect(result.toolExecutionResults).toEqual([]);
    expect(result.conversationInput).toBe(initialInput);
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it('executes a tool call and loops until the model stops calling tools', async () => {
    const addTool = tool({
      name: 'add',
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: async ({ a, b }) => ({
        sum: a + b,
      }),
    });
    const first = responseWith(
      functionCallItem('call_1', 'add', {
        a: 2,
        b: 3,
      }),
    );
    const second = terminalResponse();
    const sendRequest = queueSendRequest(first, second);

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        addTool,
      ],
      [],
    );

    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(result.allResponses).toEqual([
      first,
      second,
    ]);
    expect(result.finalResponse).toBe(second);
    expect(result.toolExecutionResults).toHaveLength(1);
    expect(result.toolExecutionResults[0]).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'add',
      source: 'client',
      result: {
        sum: 5,
      },
    });
  });

  it('supports multiple rounds of tool calls', async () => {
    const pingTool = tool({
      name: 'ping',
      inputSchema: z.object({}),
      execute: async () => 'pong',
    });
    const round1 = responseWith(functionCallItem('call_1', 'ping', {}));
    const round2 = responseWith(functionCallItem('call_2', 'ping', {}));
    const end = terminalResponse();
    const sendRequest = queueSendRequest(round1, round2, end);

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        pingTool,
      ],
      [],
    );

    expect(sendRequest).toHaveBeenCalledTimes(3);
    expect(result.allResponses).toHaveLength(3);
    expect(result.toolExecutionResults.map((r) => r.toolCallId)).toEqual([
      'call_1',
      'call_2',
    ]);
  });

  it('executes multiple tool calls in one round', async () => {
    const echoTool = tool({
      name: 'echo',
      inputSchema: z.object({
        value: z.string(),
      }),
      execute: async ({ value }) => value,
    });
    const first = responseWith(
      functionCallItem('call_a', 'echo', {
        value: 'one',
      }),
      functionCallItem('call_b', 'echo', {
        value: 'two',
      }),
    );
    const sendRequest = queueSendRequest(first, terminalResponse());

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        echoTool,
      ],
      [],
    );

    expect(result.toolExecutionResults).toHaveLength(2);
    expect(result.toolExecutionResults.map((r) => r.result)).toEqual([
      'one',
      'two',
    ]);
  });

  it('returns an error result for calls to unknown tools', async () => {
    const knownTool = tool({
      name: 'known',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    });
    const first = responseWith(
      functionCallItem('call_1', 'known', {}),
      functionCallItem('call_2', 'ghost', {}),
    );
    const sendRequest = queueSendRequest(first, terminalResponse());

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        knownTool,
      ],
      [],
    );

    const ghost = result.toolExecutionResults.find((r) => r.toolCallId === 'call_2');
    expect(ghost?.error?.message).toBe('Tool "ghost" not found in tool definitions');
    expect(ghost?.source).toBe('client');
    expect(
      result.toolExecutionResults.find((r) => r.toolCallId === 'call_1')?.error,
    ).toBeUndefined();
  });

  it('stops without executing when no tool can be auto-resolved (manual tools)', async () => {
    const manualTool = tool({
      name: 'needs_human',
      inputSchema: z.object({
        question: z.string(),
      }),
      execute: false,
    });
    const first = responseWith(
      functionCallItem('call_1', 'needs_human', {
        question: '?',
      }),
    );
    const sendRequest = queueSendRequest(first);

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        manualTool,
      ],
      [],
    );

    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(result.toolExecutionResults).toEqual([]);
    expect(result.finalResponse).toBe(first);
  });

  it('captures execute failures as error results and keeps looping', async () => {
    const failTool = tool({
      name: 'explodes',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const first = responseWith(functionCallItem('call_1', 'explodes', {}));
    const sendRequest = queueSendRequest(first, terminalResponse());

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        failTool,
      ],
      [],
    );

    expect(result.toolExecutionResults).toHaveLength(1);
    expect(result.toolExecutionResults[0]?.error?.message).toBe('kaboom');
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('marks failures from MCP-branded tools with source "mcp"', async () => {
    const mcpTool = {
      ...tool({
        name: 'mcp_tool',
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error('mcp failure');
        },
      }),
      _mcp: true,
    } as unknown as Tool;
    const first = responseWith(functionCallItem('call_1', 'mcp_tool', {}));
    const sendRequest = queueSendRequest(first, terminalResponse());

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        mcpTool,
      ],
      [],
    );

    expect(result.toolExecutionResults[0]).toMatchObject({
      source: 'mcp',
      result: null,
    });
    expect(result.toolExecutionResults[0]?.error?.message).toBe('mcp failure');
  });

  it('filters out null results (HITL tool pausing) but continues the loop', async () => {
    const hitlTool = tool({
      name: 'approve',
      inputSchema: z.object({}),
      outputSchema: z.object({
        approved: z.boolean(),
      }),
      onToolCalled: () => null,
    });
    const first = responseWith(functionCallItem('call_1', 'approve', {}));
    const sendRequest = queueSendRequest(first, terminalResponse());

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        hitlTool,
      ],
      [],
    );

    expect(result.toolExecutionResults).toEqual([]);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    'background',
    'deferred',
  ] as const)('rejects %s-lifecycle tools without invoking run', async (lifecycle) => {
    const run = vi.fn(async () => ({
      url: 'https://example.com',
    }));
    const asyncTool = tool({
      name: 'slow_render',
      lifecycle,
      inputSchema: z.object({
        script: z.string(),
      }),
      outputSchema: z.object({
        url: z.string(),
      }),
      ack: 'started',
      graceMs: 0,
      run,
    } as never);
    const first = responseWith(
      functionCallItem('call_1', 'slow_render', {
        script: 'x',
      }),
    );
    const sendRequest = queueSendRequest(first, terminalResponse());

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        asyncTool,
      ],
      [],
    );

    expect(run).not.toHaveBeenCalled();
    expect(result.toolExecutionResults[0]?.error?.message).toContain(
      `Tool "slow_render" uses an async lifecycle ('${lifecycle}')`,
    );
    expect(result.toolExecutionResults[0]?.error?.message).toContain('callModel');
  });

  it('forwards generator preliminary results to onPreliminaryResult', async () => {
    const progressTool = tool({
      name: 'progress',
      inputSchema: z.object({}),
      eventSchema: z.object({
        pct: z.number(),
      }),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      execute: async function* () {
        yield {
          pct: 50,
        };
        yield {
          done: true,
        };
      },
    });
    const first = responseWith(functionCallItem('call_1', 'progress', {}));
    const sendRequest = queueSendRequest(first, terminalResponse());
    const onPreliminaryResult = vi.fn();

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        progressTool,
      ],
      [],
      {
        onPreliminaryResult,
      },
    );

    expect(onPreliminaryResult).toHaveBeenCalledWith('call_1', {
      pct: 50,
    });
    expect(result.toolExecutionResults[0]).toMatchObject({
      result: {
        done: true,
      },
    });
    expect(result.toolExecutionResults[0]?.preliminaryResults).toBeUndefined();
  });

  it('applies nextTurnParams input changes to the conversation', async () => {
    const newInput = [
      {
        role: 'user',
        content: 'rewritten',
      },
    ] as unknown as models.InputsUnion;
    const steeringTool = tool({
      name: 'steer',
      inputSchema: z.object({}),
      execute: async () => 'ok',
      nextTurnParams: {
        input: () => newInput,
      },
    });
    const first = responseWith(functionCallItem('call_1', 'steer', {}));
    const sendRequest = queueSendRequest(first, terminalResponse());

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        steeringTool,
      ],
      [],
    );

    expect(result.conversationInput).toEqual(newInput);
    expect(sendRequest).toHaveBeenLastCalledWith(newInput, []);
  });

  it('keeps the original conversation input when nextTurnParams changes nothing', async () => {
    const plainTool = tool({
      name: 'plain',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    });
    const first = responseWith(functionCallItem('call_1', 'plain', {}));
    const sendRequest = queueSendRequest(first, terminalResponse());

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        plainTool,
      ],
      [],
    );

    expect(result.conversationInput).toBe(initialInput);
  });

  it('keeps conversation input aligned with the request when params were computed', async () => {
    const tuningTool = tool({
      name: 'tune',
      inputSchema: z.object({}),
      execute: async () => 'ok',
      nextTurnParams: {
        temperature: () => 0.2,
      },
    });
    const first = responseWith(functionCallItem('call_1', 'tune', {}));
    const sendRequest = queueSendRequest(first, terminalResponse());

    const result = await executeToolLoop(
      sendRequest,
      initialInput,
      initialRequest,
      [
        tuningTool,
      ],
      [],
    );

    // computedParams exist but contain no input override, so the loop adopts
    // the (unmodified) request input.
    expect(result.conversationInput).toEqual(initialRequest.input);
  });
});

// ---------------------------------------------------------------------------
// Result helper functions
// ---------------------------------------------------------------------------

function makeResult(overrides?: Partial<ToolExecutionResult<Tool>>): ToolExecutionResult<Tool> {
  return {
    toolCallId: 'call_1',
    toolName: 'some_tool',
    source: 'client',
    result: 'ok',
    ...overrides,
  } as ToolExecutionResult<Tool>;
}

describe('toolResultsToMap', () => {
  it('maps results by toolCallId', () => {
    const results = [
      makeResult({
        toolCallId: 'a',
        result: 1,
      }),
      makeResult({
        toolCallId: 'b',
        result: 2,
      }),
    ];

    const map = toolResultsToMap(results);

    expect(map.get('a')).toEqual({
      result: 1,
    });
    expect(map.get('b')).toEqual({
      result: 2,
    });
    expect(map.size).toBe(2);
  });

  it('returns an empty map for no results', () => {
    expect(toolResultsToMap([]).size).toBe(0);
  });
});

describe('summarizeToolExecutions', () => {
  it('summarizes successes and errors', () => {
    const summary = summarizeToolExecutions([
      makeResult({
        toolName: 'good',
        toolCallId: 'a',
      }),
      makeResult({
        toolName: 'chatty',
        toolCallId: 'b',
      }),
      makeResult({
        toolName: 'bad',
        toolCallId: 'c',
        result: null,
        error: new Error('nope'),
      }),
    ]);

    expect(summary).toBe(
      [
        '✅ good (a): SUCCESS',
        '✅ chatty (b): SUCCESS',
        '❌ bad (c): ERROR - nope',
      ].join('\n'),
    );
  });

  it('returns an empty string for no results', () => {
    expect(summarizeToolExecutions([])).toBe('');
  });
});

describe('hasToolExecutionErrors', () => {
  it('is false when no result has an error', () => {
    expect(
      hasToolExecutionErrors([
        makeResult(),
      ]),
    ).toBe(false);
    expect(hasToolExecutionErrors([])).toBe(false);
  });

  it('is true when any result has an error', () => {
    expect(
      hasToolExecutionErrors([
        makeResult(),
        makeResult({
          error: new Error('x'),
          result: null,
        }),
      ]),
    ).toBe(true);
  });
});

describe('getToolExecutionErrors', () => {
  it('returns only the errors from failed results', () => {
    const boom = new Error('boom');
    const errors = getToolExecutionErrors([
      makeResult(),
      makeResult({
        toolCallId: 'b',
        error: boom,
        result: null,
      }),
      makeResult({
        toolCallId: 'c',
        error: new Error('pow'),
        result: null,
      }),
    ]);

    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(boom);
    expect(errors.map((e) => e.message)).toEqual([
      'boom',
      'pow',
    ]);
  });

  it('returns an empty array when nothing failed', () => {
    expect(
      getToolExecutionErrors([
        makeResult(),
      ]),
    ).toEqual([]);
  });
});

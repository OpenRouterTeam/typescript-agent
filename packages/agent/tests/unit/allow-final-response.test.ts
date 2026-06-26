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
import { ToolType } from '../../src/lib/tool-types.js';

function toolCallResponse(): models.OpenResponsesResult {
  return {
    id: 'resp_tool_call',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [
      {
        type: 'function_call',
        id: 'fc_1',
        callId: 'call_abc',
        name: 'get_weather',
        arguments: '{"location":"Tokyo"}',
        status: 'completed',
      },
    ],
    error: null,
    incompleteDetails: null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: 'You are a weather assistant.',
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
  } as models.OpenResponsesResult;
}

function textResponse(text: string): models.OpenResponsesResult {
  return {
    id: 'resp_text',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [
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
    ],
    error: null,
    incompleteDetails: null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: 'You are a weather assistant.',
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
  } as models.OpenResponsesResult;
}

const weatherTool = {
  type: ToolType.Function,
  function: {
    name: 'get_weather',
    description: 'Get the weather for a location.',
    inputSchema: z.object({
      location: z.string(),
    }),
    outputSchema: z.object({
      temperature: z.number(),
    }),
    execute: async (_params: { location: string }) => ({
      temperature: 22,
    }),
  },
} as const;

const client = {} as OpenRouterCore;

describe('allowFinalResponse', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('makes a no-tools follow-up request when stopWhen halts mid-tool-call', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('Final summary.'),
      });

    const result = callModel(client, {
      model: 'test-model',
      instructions: 'You are a weather assistant.',
      input: 'What is the weather?',
      tools: [
        weatherTool,
      ] as const,
      stopWhen: stepCountIs(0),
      allowFinalResponse: true,
      parallelToolCalls: true,
      toolChoice: 'required',
    });

    const text = await result.getText();

    expect(text).toBe('Final summary.');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);

    const secondCallRequest = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    expect(secondCallRequest).toBeDefined();
    // Tool-related fields are stripped.
    expect(secondCallRequest).not.toHaveProperty('tools');
    expect(secondCallRequest).not.toHaveProperty('toolChoice');
    expect(secondCallRequest).not.toHaveProperty('parallelToolCalls');
    // Instructions ride along.
    expect(secondCallRequest.instructions).toBe('You are a weather assistant.');
    // Input contains the function_call from the halted turn AND a matching
    // function_call_output produced by actually executing the pending tool
    // (not a stub).
    const input = secondCallRequest.input as unknown[];
    expect(Array.isArray(input)).toBe(true);
    const fnCall = input.find(
      (
        i,
      ): i is {
        type: string;
        callId: string;
      } =>
        typeof i === 'object' &&
        i !== null &&
        (
          i as {
            type?: string;
          }
        ).type === 'function_call',
    );
    const fnCallOutput = input.find(
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
    expect(fnCall?.callId).toBe('call_abc');
    expect(fnCallOutput?.callId).toBe('call_abc');
    // The tool's execute fn returned { temperature: 22 } — that's the real
    // output, NOT a stub.
    expect(fnCallOutput?.output).toContain('"temperature":22');
  });

  it('appends a non-empty string allowFinalResponse as a user message', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('FINAL'),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        weatherTool,
      ] as const,
      stopWhen: stepCountIs(0),
      allowFinalResponse: 'Please summarize.',
    }).getText();

    const secondCallRequest = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    const input = secondCallRequest?.input as unknown[];
    const lastItem = input[input.length - 1] as {
      role?: string;
      content?: string;
    };
    expect(lastItem.role).toBe('user');
    expect(lastItem.content).toBe('Please summarize.');
  });

  it('does not append a user message when allowFinalResponse is the empty string', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('done'),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        weatherTool,
      ] as const,
      stopWhen: stepCountIs(0),
      allowFinalResponse: '',
    }).getText();

    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    const secondCallRequest = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    const input = secondCallRequest?.input as unknown[];
    const lastItem = input[input.length - 1] as {
      role?: string;
      type?: string;
    };
    // Last item should be the executed function_call_output, NOT a user message.
    expect(lastItem.type).toBe('function_call_output');
    expect(lastItem.role).toBeUndefined();
  });

  it('does not trigger when the loop exits without tool calls', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textResponse('plain answer'),
    });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'hi',
      allowFinalResponse: 'should not be sent',
    }).getText();

    expect(text).toBe('plain answer');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('executes pending tool calls before making the no-tools request', async () => {
    const executeSpy = vi.fn(async (_p: { location: string }) => ({
      temperature: 99,
    }));
    const spyTool = {
      type: ToolType.Function,
      function: {
        name: 'get_weather',
        description: 'Get the weather for a location.',
        inputSchema: z.object({
          location: z.string(),
        }),
        outputSchema: z.object({
          temperature: z.number(),
        }),
        execute: executeSpy,
      },
    } as const;

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('done'),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        spyTool,
      ] as const,
      stopWhen: stepCountIs(0),
      allowFinalResponse: true,
    }).getText();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      {
        location: 'Tokyo',
      },
      expect.anything(),
    );

    // The real output is in the second request's input.
    const secondCallRequest = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    const input = secondCallRequest?.input as Array<{
      type?: string;
      output?: string;
    }>;
    const fnCallOutput = input.find((i) => i.type === 'function_call_output');
    expect(fnCallOutput?.output).toContain('"temperature":99');
  });

  it('pauses for approval before executing final-response tool calls', async () => {
    const executeSpy = vi.fn(async (_p: { location: string }) => ({
      temperature: 99,
    }));
    const approvalTool = {
      type: ToolType.Function,
      function: {
        name: 'get_weather',
        description: 'Get the weather for a location.',
        inputSchema: z.object({
          location: z.string(),
        }),
        outputSchema: z.object({
          temperature: z.number(),
        }),
        requireApproval: true,
        execute: executeSpy,
      },
    } as const;
    const saved: Array<{
      status?: string;
      pendingToolCalls?: unknown[];
    }> = [];
    const stateAccessor = {
      load: async () => null,
      save: async (state: { status?: string; pendingToolCalls?: unknown[] }) => {
        saved.push(state);
      },
    };

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: toolCallResponse(),
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        approvalTool,
      ] as const,
      stopWhen: stepCountIs(0),
      allowFinalResponse: true,
      state: stateAccessor as unknown as Parameters<typeof callModel>[1]['state'],
    });

    const pending = await result.getPendingToolCalls();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.name).toBe('get_weather');
    expect(executeSpy).not.toHaveBeenCalled();
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    expect(saved.some((state) => state.status === 'awaiting_approval')).toBe(true);
  });

  it('does not trigger when allowFinalResponse is false', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: toolCallResponse(),
    });

    const finalResult = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        weatherTool,
      ] as const,
      stopWhen: stepCountIs(0),
      allowFinalResponse: false,
    }).getResponse();

    // Only the initial request was made — no follow-up.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    // Final response is the tool-call response, unchanged.
    expect(finalResult.id).toBe('resp_tool_call');
  });

  it('handles a streaming final-response (production hot path)', async () => {
    const makeStream = (response: models.OpenResponsesResult) =>
      new ReadableStream<models.StreamEvents>({
        start(controller) {
          controller.enqueue({
            type: 'response.completed',
            response,
            sequenceNumber: 0,
          } as models.StreamEvents);
          controller.close();
        },
      });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeStream(textResponse('streamed summary')),
      });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What is the weather?',
      tools: [
        weatherTool,
      ] as const,
      stopWhen: stepCountIs(0),
      allowFinalResponse: true,
    }).getText();

    expect(text).toBe('streamed summary');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('persists only real tool outputs (not stubs) on state save', async () => {
    // A turn where the model called both an executable and a manual tool.
    const mixedToolCallResponse = (): models.OpenResponsesResult =>
      ({
        ...toolCallResponse(),
        output: [
          {
            type: 'function_call',
            id: 'fc_exec',
            callId: 'call_exec',
            name: 'get_weather',
            arguments: '{"location":"Tokyo"}',
            status: 'completed',
          },
          {
            type: 'function_call',
            id: 'fc_manual',
            callId: 'call_manual',
            name: 'submit_report',
            arguments: '{"text":"hi"}',
            status: 'completed',
          },
        ],
      }) as models.OpenResponsesResult;

    const manualTool = {
      type: ToolType.Function,
      function: {
        name: 'submit_report',
        description: 'Submit a report — no execute fn (manual).',
        inputSchema: z.object({
          text: z.string(),
        }),
        outputSchema: z.object({
          ok: z.boolean(),
        }),
      },
    } as const;

    // Capture every state save by intercepting via a custom state accessor.
    const saved: Array<{
      messages?: unknown;
    }> = [];
    const stateAccessor = {
      load: async () => null,
      save: async (state: { messages?: unknown }) => {
        saved.push(state);
      },
    };

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: mixedToolCallResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('done'),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'mixed',
      tools: [
        weatherTool,
        manualTool,
      ] as const,
      stopWhen: stepCountIs(0),
      allowFinalResponse: true,
      state: stateAccessor as unknown as Parameters<typeof callModel>[1]['state'],
    }).getText();

    // Find the save call that wrote tool outputs to messages.
    const allMessages = saved.flatMap(
      (s) =>
        (s.messages as
          | Array<{
              type?: string;
              output?: string;
            }>
          | undefined) ?? [],
    );
    const persistedOutputs = allMessages.filter((m) => m.type === 'function_call_output');
    // Only the real (executed) output should be persisted — NOT the stub.
    expect(persistedOutputs.length).toBeGreaterThanOrEqual(1);
    for (const out of persistedOutputs) {
      expect(out.output).not.toMatch(/skipped/i);
    }
    // Sanity: at least one persisted output came from the executed tool.
    expect(persistedOutputs.some((o) => o.output?.includes('"temperature":22'))).toBe(true);

    // The REQUEST still has the stub paired with the manual call.
    const secondCallRequest = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    const requestInput = secondCallRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const manualStub = requestInput.find(
      (i) => i.type === 'function_call_output' && i.callId === 'call_manual',
    );
    expect(manualStub).toBeDefined();
    expect(manualStub?.output).toMatch(/skipped/i);
  });
});

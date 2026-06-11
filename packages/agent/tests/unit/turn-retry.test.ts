/**
 * Tests for turn-level retry (`retryTurn` option).
 *
 * A "turn" is one provider request + stream consumption. These tests verify:
 * - a dead follow-up stream is retried with the accumulated conversation
 *   intact (tool results are NOT re-executed or lost)
 * - the initial (turn 0) stream is retried by re-issuing the resolved request
 * - silently-hung streams are converted into retryable failures via
 *   `idleTimeoutMs`
 * - `turn.retry` events surface on getFullResponsesStream
 * - retry limits, retryability policy, and backoff hooks are honored
 */
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
import { TurnIdleTimeoutError, TurnStreamEndedError } from '../../src/lib/turn-retry.js';

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
    instructions: null,
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
    instructions: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
  } as models.OpenResponsesResult;
}

/** Stream that emits a completed event for the given response, then closes. */
function completedStream(response: models.OpenResponsesResult): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({
        type: 'response.completed',
        response,
      });
      controller.close();
    },
  });
}

/**
 * Stream that emits some deltas then closes WITHOUT a terminal event — the
 * signature of an upstream stream dying mid-flight.
 */
function deadStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({
        type: 'response.output_text.delta',
        delta: 'partial...',
      });
      controller.close();
    },
  });
}

/** Stream that emits one delta then never produces anything again (hang). */
function hangingStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({
        type: 'response.output_text.delta',
        delta: 'and then silence',
      });
      // Never closes, never errors — a silently-hung upstream connection.
    },
  });
}

/** Stream whose transport errors mid-read. */
function erroringStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.error(new Error('network drop mid-stream'));
    },
  });
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
    execute: vi.fn(async (_params: { location: string }) => ({
      temperature: 22,
    })),
  },
} as const;

const client = {} as OpenRouterCore;

function ok(value: unknown) {
  return {
    ok: true,
    value,
  };
}

describe('retryTurn: follow-up turn retry', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
    weatherTool.function.execute.mockClear();
  });

  it('retries a dead follow-up stream with the accumulated conversation intact', async () => {
    mockBetaResponsesSend
      // Turn 0: model asks for the tool
      .mockResolvedValueOnce(ok(completedStream(toolCallResponse())))
      // Turn 1, attempt 0: stream dies without a terminal event
      .mockResolvedValueOnce(ok(deadStream()))
      // Turn 1, attempt 1 (retry): success
      .mockResolvedValueOnce(ok(completedStream(textResponse('Sunny, 22C'))));

    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {
        limit: 2,
      },
    });

    const text = await result.getText();

    expect(text).toBe('Sunny, 22C');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);
    // The tool executed exactly once — retry re-sends the request, it does
    // NOT re-execute tools.
    expect(weatherTool.function.execute).toHaveBeenCalledTimes(1);

    // The retried request is byte-identical to the failed one: same
    // accumulated conversation including the function_call_output.
    const attempt0Input = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input;
    const attempt1Input = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest?.input;
    expect(attempt1Input).toEqual(attempt0Input);
    const hasToolOutput = (
      attempt1Input as Array<{
        type?: string;
      }>
    ).some((item) => item.type === 'function_call_output');
    expect(hasToolOutput).toBe(true);
  });

  it('does not retry when retryTurn is not configured', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(completedStream(toolCallResponse())))
      .mockResolvedValueOnce(ok(deadStream()));

    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
    });

    await expect(result.getText()).rejects.toThrow('Stream ended without completion event');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry limit is exhausted', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(completedStream(toolCallResponse())))
      // Turn 1: initial attempt + 2 retries, all dead
      .mockResolvedValueOnce(ok(deadStream()))
      .mockResolvedValueOnce(ok(deadStream()))
      .mockResolvedValueOnce(ok(deadStream()));

    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {
        limit: 2,
      },
    });

    await expect(result.getText()).rejects.toThrow(TurnStreamEndedError);
    // 1 (turn 0) + 3 (turn 1 attempts)
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(4);
  });

  it('respects a custom isRetryable that declines the retry', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(completedStream(toolCallResponse())))
      .mockResolvedValueOnce(ok(deadStream()));

    const isRetryable = vi.fn(() => false);
    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {
        limit: 2,
        isRetryable,
      },
    });

    await expect(result.getText()).rejects.toThrow(TurnStreamEndedError);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    expect(isRetryable).toHaveBeenCalledTimes(1);
    const [error, context] = isRetryable.mock.calls[0] as unknown as [
      Error,
      {
        turnNumber: number;
        attempt: number;
      },
    ];
    expect(error).toBeInstanceOf(TurnStreamEndedError);
    expect(context.turnNumber).toBe(1);
    expect(context.attempt).toBe(1);
  });

  it('retries transport errors that surface mid-stream', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(completedStream(toolCallResponse())))
      .mockResolvedValueOnce(ok(erroringStream()))
      .mockResolvedValueOnce(ok(completedStream(textResponse('Recovered'))));

    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {},
    });

    await expect(result.getText()).resolves.toBe('Recovered');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);
  });

  it('invokes the backoff function with the attempt number', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(completedStream(toolCallResponse())))
      .mockResolvedValueOnce(ok(deadStream()))
      .mockResolvedValueOnce(ok(completedStream(textResponse('Done'))));

    const backoffMs = vi.fn(() => 0);
    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {
        backoffMs,
      },
    });

    await result.getText();
    expect(backoffMs).toHaveBeenCalledWith(1);
  });
});

describe('retryTurn: idle timeout (hung streams)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
    weatherTool.function.execute.mockClear();
  });

  it('converts a silently-hung follow-up stream into a retried turn', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(completedStream(toolCallResponse())))
      .mockResolvedValueOnce(ok(hangingStream()))
      .mockResolvedValueOnce(ok(completedStream(textResponse('Recovered after hang'))));

    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {
        limit: 1,
        idleTimeoutMs: 50,
      },
    });

    await expect(result.getText()).resolves.toBe('Recovered after hang');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);
  });

  it('fails with TurnIdleTimeoutError when retries are exhausted on hangs', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(completedStream(toolCallResponse())))
      .mockResolvedValueOnce(ok(hangingStream()))
      .mockResolvedValueOnce(ok(hangingStream()));

    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {
        limit: 1,
        idleTimeoutMs: 50,
      },
    });

    const error = await result.getText().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TurnIdleTimeoutError);
    expect((error as TurnIdleTimeoutError).idleTimeoutMs).toBe(50);
  });
});

describe('retryTurn: initial turn (turn 0)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
    weatherTool.function.execute.mockClear();
  });

  it('re-issues the initial request when the turn-0 stream dies', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(deadStream()))
      .mockResolvedValueOnce(ok(completedStream(textResponse('Hello!'))));

    const result = callModel(client, {
      model: 'test-model',
      input: 'Hi',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {},
    });

    await expect(result.getText()).resolves.toBe('Hello!');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);

    // Retried request carries the same resolved input.
    const firstInput = mockBetaResponsesSend.mock.calls[0]?.[1]?.responsesRequest?.input;
    const retryInput = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest?.input;
    expect(retryInput).toEqual(firstInput);
  });

  it('retries a hung turn-0 stream via the idle timeout', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(hangingStream()))
      .mockResolvedValueOnce(ok(completedStream(textResponse('Recovered'))));

    const result = callModel(client, {
      model: 'test-model',
      input: 'Hi',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {
        idleTimeoutMs: 50,
      },
    });

    await expect(result.getText()).resolves.toBe('Recovered');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('retries send-phase failures (HTTP 5xx) before any stream exists', async () => {
    const serverError = Object.assign(new Error('Internal Server Error'), {
      statusCode: 500,
    });
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: false,
        error: serverError,
      })
      .mockResolvedValueOnce(ok(completedStream(textResponse('Recovered'))));

    const result = callModel(client, {
      model: 'test-model',
      input: 'Hi',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {},
    });

    await expect(result.getText()).resolves.toBe('Recovered');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable HTTP errors (400) by default', async () => {
    const badRequest = Object.assign(new Error('Bad Request'), {
      statusCode: 400,
    });
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: false,
      error: badRequest,
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Hi',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {},
    });

    await expect(result.getText()).rejects.toThrow('Bad Request');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('does not retry a response.failed terminal event by default', async () => {
    const failedStream = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'response.failed',
          response: {
            ...textResponse(''),
            status: 'failed',
            error: {
              code: 'refusal',
              message: 'Model refused',
            },
          },
        });
        controller.close();
      },
    });
    mockBetaResponsesSend.mockResolvedValueOnce(ok(failedStream));

    const result = callModel(client, {
      model: 'test-model',
      input: 'Hi',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {
        limit: 3,
      },
    });

    await expect(result.getText()).rejects.toThrow('Response failed');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });
});

describe('retryTurn: turn.retry events on getFullResponsesStream', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
    weatherTool.function.execute.mockClear();
  });

  it('emits turn.retry between turn.start and turn.end for a retried follow-up', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(completedStream(toolCallResponse())))
      .mockResolvedValueOnce(ok(deadStream()))
      .mockResolvedValueOnce(ok(completedStream(textResponse('Sunny'))));

    const result = callModel(client, {
      model: 'test-model',
      input: 'What is the weather in Tokyo?',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {},
    });

    const events: Array<{
      type: string;
      turnNumber?: number;
      attempt?: number;
    }> = [];
    for await (const event of result.getFullResponsesStream()) {
      if ('type' in event) {
        events.push(
          event as {
            type: string;
            turnNumber?: number;
            attempt?: number;
          },
        );
      }
    }

    const retryEvents = events.filter((e) => e.type === 'turn.retry');
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]).toMatchObject({
      turnNumber: 1,
      attempt: 1,
    });

    // Exactly one turn.start and one turn.end for turn 1 — the retry does
    // not duplicate the turn delimiters.
    const turn1Starts = events.filter((e) => e.type === 'turn.start' && e.turnNumber === 1);
    const turn1Ends = events.filter((e) => e.type === 'turn.end' && e.turnNumber === 1);
    expect(turn1Starts).toHaveLength(1);
    expect(turn1Ends).toHaveLength(1);

    // Ordering: start < retry < end
    const startIdx = events.findIndex((e) => e.type === 'turn.start' && e.turnNumber === 1);
    const retryIdx = events.findIndex((e) => e.type === 'turn.retry');
    const endIdx = events.findIndex((e) => e.type === 'turn.end' && e.turnNumber === 1);
    expect(startIdx).toBeLessThan(retryIdx);
    expect(retryIdx).toBeLessThan(endIdx);
  });

  it('recovers a dead turn-0 stream without poisoning stream consumers', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce(ok(deadStream()))
      .mockResolvedValueOnce(ok(completedStream(textResponse('Hello!'))));

    const result = callModel(client, {
      model: 'test-model',
      input: 'Hi',
      tools: [
        weatherTool,
      ] as const,
      retryTurn: {},
    });

    const events: Array<{
      type: string;
      turnNumber?: number;
    }> = [];
    for await (const event of result.getFullResponsesStream()) {
      if ('type' in event) {
        events.push(
          event as {
            type: string;
            turnNumber?: number;
          },
        );
      }
    }

    const retryEvents = events.filter((e) => e.type === 'turn.retry');
    expect(retryEvents).toHaveLength(1);

    const turn0Ends = events.filter((e) => e.type === 'turn.end' && e.turnNumber === 0);
    expect(turn0Ends).toHaveLength(1);

    // The stream completed cleanly and the text is retrievable.
    await expect(result.getText()).resolves.toBe('Hello!');
  });
});

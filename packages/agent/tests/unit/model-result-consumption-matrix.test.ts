import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { tool } from '../../src/lib/tool.js';

const client = {} as OpenRouterCore;

function completedStream(
  response: models.OpenResponsesResult,
): ReadableStream<models.StreamEvents> {
  return new ReadableStream<models.StreamEvents>({
    start(controller) {
      controller.enqueue({
        type: 'response.completed',
        response,
        sequenceNumber: 0,
      } as models.StreamEvents);
      controller.close();
    },
  });
}

function completedToolStream(
  response: models.OpenResponsesResult,
): ReadableStream<models.StreamEvents> {
  return new ReadableStream<models.StreamEvents>({
    start(controller) {
      controller.enqueue({
        type: 'response.output_item.added',
        item: response.output[0],
        outputIndex: 0,
        sequenceNumber: 0,
      } as models.StreamEvents);
      controller.enqueue({
        type: 'response.output_item.done',
        item: response.output[0],
        outputIndex: 0,
        sequenceNumber: 1,
      } as models.StreamEvents);
      controller.enqueue({
        type: 'response.completed',
        response,
        sequenceNumber: 2,
      } as models.StreamEvents);
      controller.close();
    },
  });
}

function toolResponse(): models.OpenResponsesResult {
  return {
    id: 'response_tool',
    status: 'completed',
    output: [
      {
        type: 'function_call',
        id: 'item_call',
        callId: 'call_echo',
        name: 'echo',
        arguments: '{}',
        status: 'completed',
      },
    ],
  } as models.OpenResponsesResult;
}

function textResponse(): models.OpenResponsesResult {
  return {
    id: 'response_text',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'message_text',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'done',
            annotations: [],
          },
        ],
      },
    ],
  } as models.OpenResponsesResult;
}

function textDeltaStream(
  response: models.OpenResponsesResult,
): ReadableStream<models.StreamEvents> {
  return new ReadableStream<models.StreamEvents>({
    start(controller) {
      controller.enqueue({
        type: 'response.output_text.delta',
        delta: 'done',
        itemId: 'message_text',
        outputIndex: 0,
        contentIndex: 0,
        sequenceNumber: 0,
      } as models.StreamEvents);
      controller.enqueue({
        type: 'response.completed',
        response,
        sequenceNumber: 1,
      } as models.StreamEvents);
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

afterEach(() => {
  mockBetaResponsesSend.mockReset();
  vi.restoreAllMocks();
});

describe('ModelResult consumption matrix', () => {
  it('uses the unified journal as the single replay owner for tool streaming', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: completedStream(toolResponse()),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: completedStream(textResponse()),
      });
    const createConsumer = vi.spyOn(ReusableReadableStream.prototype, 'createConsumer');
    let executions = 0;
    const echo = tool({
      name: 'echo',
      inputSchema: z.object({}),
      contextSchema: z.object({
        update: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      execute: async (_input, context) => {
        executions += 1;
        for (let update = 1; update <= 100; update += 1) {
          context.setContext({
            update,
          });
        }
        return {
          ok: true,
        };
      },
    });
    const result = callModel(client, {
      model: 'test-model',
      input: 'call echo',
      tools: [
        echo,
      ],
      context: {
        echo: {
          update: 0,
        },
      },
      streamReplay: 'active-consumers',
    });

    const contextUpdatesPromise = collect(result.getContextUpdates());
    const firstEventsPromise = collect(result.getFullResponsesStream());
    const responsePromise = result.getResponse();
    const [contextUpdates, firstEvents, response] = await Promise.all([
      contextUpdatesPromise,
      firstEventsPromise,
      responsePromise,
    ]);

    expect(response.id).toBe('response_text');
    expect(executions).toBe(1);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    expect(createConsumer).not.toHaveBeenCalled();
    expect(contextUpdates).toHaveLength(100);
    expect(contextUpdates.map((snapshot) => snapshot.echo.update)).toEqual(
      Array.from(
        {
          length: 100,
        },
        (_, index) => index + 1,
      ),
    );
    const expectedEventTypes = [
      'turn.start',
      'response.completed',
      'turn.end',
      'tool.result',
      'tool.call_output',
      'turn.start',
      'response.completed',
      'turn.end',
    ];
    expect(firstEvents.map((event) => event.type)).toEqual(expectedEventTypes);
  });

  it('replays initial tool calls from the unified journal without executing them', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: completedToolStream(toolResponse()),
    });
    const manualEcho = tool({
      name: 'echo',
      inputSchema: z.object({}),
      execute: false,
    });
    const result = callModel(client, {
      model: 'test-model',
      input: 'call echo',
      tools: [
        manualEcho,
      ],
    });

    const calls = await collect(result.getToolCallsStream());

    expect(calls).toEqual([
      {
        id: 'call_echo',
        name: 'echo',
        arguments: {},
      },
    ]);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('supports concurrent no-tool text and completion consumers in active mode', async () => {
    const response = textResponse();
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textDeltaStream(response),
    });
    const result = callModel(client, {
      model: 'test-model',
      input: 'say done',
      streamReplay: 'active-consumers',
    });

    const textPromise = collect(result.getTextStream());
    const responsePromise = result.getResponse();

    await expect(textPromise).resolves.toEqual([
      'done',
    ]);
    await expect(responsePromise).resolves.toBe(response);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });
});

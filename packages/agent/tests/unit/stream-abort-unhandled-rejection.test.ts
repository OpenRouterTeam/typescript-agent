/**
 * Abort matrix for #113: aborting a run through any consumer surface must
 * reject that consumer and must NOT leave a dangling rejected promise behind
 * (which surfaces as a process-level `unhandledRejection`).
 *
 * The per-getter cases matter because every stream getter shares the same
 * broadcaster/execution path; a regression there shows up on all of them,
 * not only on `getFullResponsesStream`.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';

const client = {
  _options: {},
} as OpenRouterCore;

const echoTool = tool({
  name: 'echo',
  inputSchema: z.object({
    value: z.string(),
  }),
  execute: async ({ value }) => ({
    echoed: value,
  }),
});

const textDelta = {
  type: 'response.output_text.delta',
  delta: 'chunk',
  sequenceNumber: 0,
} as models.StreamEvents;

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}

/** A stream that emits `events` and then errors with the signal's reason on abort. */
function abortableStream(
  signal: AbortSignal | undefined,
  events: models.StreamEvents[],
): ReadableStream<models.StreamEvents> {
  return new ReadableStream<models.StreamEvents>({
    start(c) {
      for (const e of events) {
        c.enqueue(e);
      }
      signal?.addEventListener('abort', () => {
        c.error(signal.reason ?? new Error('Aborted'));
      });
    },
  });
}

function mockAbortableSend(
  events: models.StreamEvents[] = [
    textDelta,
  ],
): void {
  mockBetaResponsesSend.mockImplementation(
    async (
      _client: unknown,
      _req: unknown,
      options: {
        signal?: AbortSignal;
      },
    ) => ({
      ok: true,
      value: abortableStream(options.signal, events),
    }),
  );
}

function completedWithToolCall(name: string): models.StreamEvents {
  return {
    type: 'response.completed',
    sequenceNumber: 1,
    response: {
      id: 'resp_tool',
      object: 'response',
      createdAt: 0,
      model: 'test-model',
      status: 'completed',
      completedAt: 0,
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          callId: 'call_1',
          name,
          arguments: '{}',
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
    },
  } as unknown as models.StreamEvents;
}

/** Let any dangling rejections reach the process-level handler. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let unhandledRejections: unknown[] = [];
const onUnhandled = (err: unknown) => {
  unhandledRejections.push(err);
};

beforeEach(() => {
  mockBetaResponsesSend.mockReset();
  unhandledRejections = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

const streamGetters = [
  'getFullResponsesStream',
  'getTextStream',
  'getItemsStream',
  'getReasoningStream',
  'getToolStream',
  'getToolCallsStream',
  'getNewMessagesStream',
] as const;

describe('aborting a tool-enabled run does not leak unhandled rejections (#113)', () => {
  for (const getter of streamGetters) {
    it(`${getter}: abort mid-stream rejects the consumer only`, async () => {
      const controller = new AbortController();
      mockAbortableSend();
      // Abort once the request has been dispatched and the stream is live.
      mockBetaResponsesSend.mockImplementationOnce(
        async (
          _client: unknown,
          _req: unknown,
          options: {
            signal?: AbortSignal;
          },
        ) => {
          setTimeout(() => controller.abort(abortError()), 0);
          return {
            ok: true,
            value: abortableStream(options.signal, [
              textDelta,
            ]),
          };
        },
      );

      const result = callModel(client, {
        model: 'test-model',
        input: 'hello',
        tools: [
          echoTool,
        ],
        signal: controller.signal,
      });

      let streamError: unknown;
      try {
        const stream: AsyncIterable<unknown> = result[getter]();
        for await (const _event of stream) {
          // drain
        }
      } catch (err) {
        streamError = err;
      }
      await settle();

      expect(streamError).toBeDefined();
      expect(unhandledRejections).toHaveLength(0);
    });
  }

  it('getItemsStream: abort while a client tool is executing', async () => {
    const controller = new AbortController();
    const slowTool = tool({
      name: 'slow',
      inputSchema: z.object({}),
      execute: async () => {
        controller.abort(abortError());
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ok: true,
        };
      },
    });
    mockAbortableSend([
      textDelta,
      completedWithToolCall('slow'),
    ]);

    const result = callModel(client, {
      model: 'test-model',
      input: 'hello',
      tools: [
        slowTool,
      ],
      signal: controller.signal,
    });

    let streamError: unknown;
    try {
      for await (const _item of result.getItemsStream()) {
        // drain
      }
    } catch (err) {
      streamError = err;
    }
    await settle();

    expect(streamError).toBeDefined();
    expect(unhandledRejections).toHaveLength(0);
  });

  it('getFullResponsesStream: early break, then abort', async () => {
    const controller = new AbortController();
    mockAbortableSend();

    const result = callModel(client, {
      model: 'test-model',
      input: 'hello',
      tools: [
        echoTool,
      ],
      signal: controller.signal,
    });

    for await (const _event of result.getFullResponsesStream()) {
      break;
    }
    controller.abort(abortError());
    await settle();

    expect(unhandledRejections).toHaveLength(0);
  });

  it('parallel runs sharing one signal: every consumer rejects, nothing leaks', async () => {
    const controller = new AbortController();
    mockAbortableSend();

    const runOne = async (): Promise<unknown> => {
      const result = callModel(client, {
        model: 'test-model',
        input: 'hello',
        tools: [
          echoTool,
        ],
        signal: controller.signal,
      });
      try {
        for await (const _delta of result.getTextStream()) {
          // drain
        }
      } catch (err) {
        return err;
      }
      return undefined;
    };

    const runs = [
      runOne(),
      runOne(),
      runOne(),
    ];
    await vi.waitFor(() => expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3));
    controller.abort(abortError());
    const errors = await Promise.all(runs);
    await settle();

    expect(errors.every((e) => e !== undefined)).toBe(true);
    expect(unhandledRejections).toHaveLength(0);
  });

  it('getText: abort rejects with and without tools', async () => {
    const controller = new AbortController();
    mockAbortableSend();

    const withTools = callModel(client, {
      model: 'test-model',
      input: 'hello',
      tools: [
        echoTool,
      ],
      signal: controller.signal,
    }).getText();
    const withoutTools = callModel(client, {
      model: 'test-model',
      input: 'hello',
      signal: controller.signal,
    }).getText();

    await vi.waitFor(() => expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2));
    controller.abort(abortError());
    const settled = await Promise.allSettled([
      withTools,
      withoutTools,
    ]);
    await settle();

    expect(settled.map((s) => s.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(unhandledRejections).toHaveLength(0);
  });
});

/**
 * callModel `streamTimeout` (DEV-723): the stream watchdog armed per model
 * request, composed with the run signal, aborting the hung request, and
 * surfacing StreamStalledError on every consumption path.
 *
 * betaResponsesSend is mocked; each mocked request errors its body stream
 * when its request signal aborts, like a real fetch body does.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { StreamStalledError } from '../../src/index.js';
import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';
import type { ControlledStream } from '../utils/stream-fixtures.js';
import {
  completedEvent,
  controlledStream,
  createdEvent,
  drain,
  emptyMessageShell,
  functionCallArgsDelta,
  healthyTextEvents,
  healthyToolCallEvents,
  textDelta,
  textResponse,
  toolCallResponse,
} from '../utils/stream-fixtures.js';

const client = {
  _options: {},
} as OpenRouterCore;

const echoTool = tool({
  name: 'echo',
  inputSchema: z.object({
    value: z.string(),
  }),
  outputSchema: z.object({
    echoed: z.string(),
  }),
  execute: async ({ value }) => ({
    echoed: value,
  }),
});

interface Dispatch {
  request: models.ResponsesRequest;
  signal: AbortSignal | undefined;
  options: Record<string, unknown> | undefined;
}

const dispatches: Dispatch[] = [];

/** Answer the next requests with these streams, in order. */
function serve(...streams: ControlledStream<models.StreamEvents>[]): void {
  for (const source of streams) {
    mockBetaResponsesSend.mockImplementationOnce(
      async (
        _client: unknown,
        params: {
          responsesRequest: models.ResponsesRequest;
        },
        options?: {
          signal?: AbortSignal;
        },
      ) => {
        const signal = options?.signal;
        dispatches.push({
          request: params.responsesRequest,
          signal,
          options,
        });
        signal?.addEventListener('abort', () => source.error(signal.reason));
        return {
          ok: true,
          value: source.stream,
        };
      },
    );
  }
}

/** Settle a promise into a value without letting it reject unobserved. */
function settle<T>(promise: Promise<T>): Promise<{
  value?: T;
  error?: unknown;
}> {
  return promise.then(
    (value) => ({
      value,
    }),
    (error: unknown) => ({
      error,
    }),
  );
}

const TIMEOUT = {
  firstContentMs: 100,
  contentIntervalMs: 100,
};

beforeEach(() => {
  vi.useFakeTimers();
  mockBetaResponsesSend.mockReset();
  dispatches.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('streamTimeout: single turn', () => {
  it('fails fast when a stream sends only metadata, then goes silent', async () => {
    const source = controlledStream([
      createdEvent(),
      emptyMessageShell(),
    ]);
    serve(source);
    const outcome = settle(
      callModel(client, {
        model: 'test-model',
        input: 'hi',
        streamTimeout: TIMEOUT,
      }).getText(),
    );

    await vi.advanceTimersByTimeAsync(99);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await outcome;
    expect(error).toBeInstanceOf(StreamStalledError);
    expect(error).toMatchObject({
      phase: 'first_content',
      timeoutMs: 100,
      receivedAnyContent: false,
      retryable: true,
    });
    // The hung request is torn down: its signal aborted with the stall,
    // which errors (tears down) its body stream.
    expect(dispatches[0]?.signal?.aborted).toBe(true);
    expect(dispatches[0]?.signal?.reason).toBe(error);
    expect(source.finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a healthy stream completes and leaves no timers behind', async () => {
    serve(controlledStream(healthyTextEvents('hello')));
    const text = await callModel(client, {
      model: 'test-model',
      input: 'hi',
      streamTimeout: TIMEOUT,
    }).getText();
    expect(text).toBe('hello');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is off by default: no watchdog, no extra request signal', async () => {
    const source = controlledStream([
      createdEvent(),
    ]);
    serve(source);
    const outcome = settle(
      callModel(client, {
        model: 'test-model',
        input: 'hi',
      }).getText(),
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(dispatches[0]?.signal).toBeUndefined();
    source.push(emptyMessageShell(), textDelta('late'), completedEvent(textResponse('late')));
    source.close();
    expect((await outcome).value).toBe('late');
  });

  it('stalls between content events once generation started (not retryable)', async () => {
    const source = controlledStream([
      createdEvent(),
      emptyMessageShell(),
      textDelta('partial outp'),
    ]);
    serve(source);
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      streamTimeout: TIMEOUT,
    });
    const streamed = settle(drain(result.getTextStream()));
    await vi.advanceTimersByTimeAsync(100);
    const { value } = await streamed;
    expect(value?.items).toEqual([
      'partial outp',
    ]);
    expect(value?.error).toBeInstanceOf(StreamStalledError);
    expect(value?.error).toMatchObject({
      phase: 'between_content',
      receivedAnyContent: true,
      retryable: false,
    });
  });

  it('rejects every concurrent consumer with the same stall', async () => {
    serve(
      controlledStream([
        createdEvent(),
      ]),
    );
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      streamTimeout: TIMEOUT,
    });
    const outcomes = [
      settle(result.getText()),
      settle(drain(result.getTextStream()).then((r) => Promise.reject(r.error))),
      settle(drain(result.getFullResponsesStream()).then((r) => Promise.reject(r.error))),
      settle(drain(result.getItemsStream()).then((r) => Promise.reject(r.error))),
      settle(drain(result.getReasoningStream()).then((r) => Promise.reject(r.error))),
    ];
    await vi.advanceTimersByTimeAsync(100);
    const errors = (await Promise.all(outcomes)).map((o) => o.error);
    for (const error of errors) {
      expect(error).toBeInstanceOf(StreamStalledError);
    }
    expect(new Set(errors).size).toBe(1);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('a run-signal abort is reported as the abort, never as a stall', async () => {
    const controller = new AbortController();
    serve(
      controlledStream([
        createdEvent(),
      ]),
    );
    const outcome = settle(
      callModel(client, {
        model: 'test-model',
        input: 'hi',
        signal: controller.signal,
        streamTimeout: TIMEOUT,
      }).getText(),
    );
    await vi.advanceTimersByTimeAsync(50);
    const reason = new Error('user cancelled');
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await outcome).error).toBe(reason);
    expect(dispatches[0]?.signal?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps RequestOptions (timeoutMs, headers) and composes the watchdog signal in', async () => {
    serve(controlledStream(healthyTextEvents('ok')));
    await callModel(
      client,
      {
        model: 'test-model',
        input: 'hi',
        streamTimeout: TIMEOUT,
      },
      {
        timeoutMs: 60_000,
      },
    ).getText();
    const dispatch = dispatches[0];
    expect(dispatch?.options?.['timeoutMs']).toBe(60_000);
    expect(dispatch?.signal).toBeInstanceOf(AbortSignal);
    expect(dispatch?.signal?.aborted).toBe(false);
  });

  it('never sends streamTimeout to the API (static and async-resolved requests)', async () => {
    serve(controlledStream(healthyTextEvents('a')), controlledStream(healthyTextEvents('b')));
    await callModel(client, {
      model: 'test-model',
      input: 'hi',
      streamTimeout: TIMEOUT,
    }).getText();
    await callModel(client, {
      model: 'test-model',
      input: 'hi',
      temperature: async () => 0.5,
      streamTimeout: TIMEOUT,
    }).getText();
    for (const dispatch of dispatches) {
      expect(dispatch.request).not.toHaveProperty('streamTimeout');
    }
    expect(dispatches[1]?.request.temperature).toBe(0.5);
  });
});

describe('streamTimeout: multi-turn tool loop', () => {
  /** Turn 1 produces its tool call after `delayMs`, then completes. */
  function slowToolTurn(delayMs: number): {
    source: ControlledStream<models.StreamEvents>;
    release: () => Promise<void>;
  } {
    const source = controlledStream([
      createdEvent(),
    ]);
    return {
      source,
      release: async () => {
        await vi.advanceTimersByTimeAsync(delayMs);
        source.push(
          functionCallArgsDelta('{"value":"a"}'),
          completedEvent(
            toolCallResponse('echo', {
              value: 'a',
            }),
          ),
        );
        source.close();
      },
    };
  }

  function toolsRun() {
    return callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        echoTool,
      ] as const,
      streamTimeout: TIMEOUT,
    });
  }

  it('re-arms deadlines per request: turn 1 passes, a stalled turn 2 fails', async () => {
    const turn1 = slowToolTurn(80);
    const turn2 = controlledStream([
      createdEvent(),
    ]);
    serve(turn1.source, turn2);
    const outcome = settle(toolsRun().getText());

    await turn1.release();
    // Turn 2 is dispatched; its own deadline starts now.
    await vi.advanceTimersByTimeAsync(99);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    const { error } = await outcome;
    expect(error).toBeInstanceOf(StreamStalledError);
    expect(dispatches[0]?.signal).not.toBe(dispatches[1]?.signal);
    expect(dispatches[0]?.signal?.aborted).toBe(false);
    expect(dispatches[1]?.signal?.aborted).toBe(true);
    expect(turn2.finished).toBe(true);
  });

  it('total run time beyond the deadline is fine when every turn is within it', async () => {
    const turn1 = slowToolTurn(80);
    const turn2 = controlledStream([
      createdEvent(),
    ]);
    serve(turn1.source, turn2);
    const outcome = settle(toolsRun().getText());
    await turn1.release();
    await vi.advanceTimersByTimeAsync(80);
    turn2.push(emptyMessageShell(), textDelta('done'), completedEvent(textResponse('done')));
    turn2.close();
    expect((await outcome).value).toBe('done');
  });

  it('a follow-up stall rejects concurrent stream consumers', async () => {
    const turn2 = controlledStream([
      createdEvent(),
    ]);
    serve(
      controlledStream(
        healthyToolCallEvents('echo', {
          value: 'a',
        }),
      ),
      turn2,
    );
    const result = toolsRun();
    const text = settle(drain(result.getTextStream()));
    const full = settle(drain(result.getFullResponsesStream()));
    const tools = settle(drain(result.getToolStream()));
    await vi.advanceTimersByTimeAsync(100);
    for (const outcome of await Promise.all([
      text,
      full,
      tools,
    ])) {
      expect(outcome.value?.error).toBeInstanceOf(StreamStalledError);
    }
    const fullEvents = (await full).value?.items ?? [];
    // Turn 1 completed and its tool ran before turn 2 stalled.
    expect(fullEvents.some((e) => e.type === 'tool.result')).toBe(true);
  });

  it('a consumer that walks away early does not leave an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      serve(
        controlledStream(
          healthyToolCallEvents('echo', {
            value: 'a',
          }),
        ),
        controlledStream([
          createdEvent(),
        ]),
      );
      const result = toolsRun();
      for await (const _event of result.getFullResponsesStream()) {
        break;
      }
      await vi.advanceTimersByTimeAsync(500);
      // Let Node flush its unhandled-rejection bookkeeping.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

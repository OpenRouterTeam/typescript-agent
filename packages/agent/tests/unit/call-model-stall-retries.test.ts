/**
 * `streamTimeout.maxStallRetries` (DEV-723): requests that stall before any
 * content are transparently re-issued; nothing from a discarded attempt
 * reaches consumers; stalls after content are never retried.
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
import { awaitFirstContent, normalizeStallRetries } from '../../src/lib/stream-watchdog.js';
import { tool } from '../../src/lib/tool.js';
import type { ControlledStream } from '../utils/stream-fixtures.js';
import {
  controlledStream,
  createdEvent,
  drain,
  emptyMessageShell,
  healthyTextEvents,
  healthyToolCallEvents,
  textDelta,
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

const signals: (AbortSignal | undefined)[] = [];

function serve(...streams: ControlledStream<models.StreamEvents>[]): void {
  for (const source of streams) {
    mockBetaResponsesSend.mockImplementationOnce(
      async (
        _client: unknown,
        _params: unknown,
        options?: {
          signal?: AbortSignal;
        },
      ) => {
        const signal = options?.signal;
        signals.push(signal);
        signal?.addEventListener('abort', () => source.error(signal.reason));
        return {
          ok: true,
          value: source.stream,
        };
      },
    );
  }
}

/** A stream that sends metadata, then hangs forever. */
function stalling(): ControlledStream<models.StreamEvents> {
  return controlledStream([
    createdEvent(),
    emptyMessageShell(),
  ]);
}

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

const RETRY_ONCE = {
  firstContentMs: 100,
  contentIntervalMs: 100,
  maxStallRetries: 1,
};

beforeEach(() => {
  vi.useFakeTimers();
  mockBetaResponsesSend.mockReset();
  signals.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeStallRetries', () => {
  it('is 0 unless firstContentMs is active, and floors fractional budgets', () => {
    expect(normalizeStallRetries(undefined)).toBe(0);
    expect(
      normalizeStallRetries({
        maxStallRetries: 3,
      }),
    ).toBe(0);
    expect(
      normalizeStallRetries({
        contentIntervalMs: 50,
        maxStallRetries: 3,
      }),
    ).toBe(0);
    expect(
      normalizeStallRetries({
        firstContentMs: 50,
        maxStallRetries: -1,
      }),
    ).toBe(0);
    expect(
      normalizeStallRetries({
        firstContentMs: 50,
        maxStallRetries: Number.POSITIVE_INFINITY,
      }),
    ).toBe(0);
    expect(
      normalizeStallRetries({
        firstContentMs: 50,
        maxStallRetries: 2.7,
      }),
    ).toBe(2);
  });
});

describe('awaitFirstContent', () => {
  it('cancelling the live stream cancels the source', async () => {
    const source = controlledStream([
      'meta',
      'content',
    ]);
    const outcome = await awaitFirstContent(source.stream, (e) => e === 'content');
    expect(outcome.kind).toBe('live');
    if (outcome.kind === 'live') {
      await outcome.stream.cancel('done');
    }
    expect(source.cancelled).toBe(true);
  });

  it('replays buffered events, then forwards the rest', async () => {
    const source = controlledStream([
      'meta',
      'content',
    ]);
    const outcome = await awaitFirstContent(source.stream, (e) => e === 'content');
    source.push('more');
    source.close();
    expect(outcome.kind === 'live' && (await drain(outcome.stream)).items).toEqual([
      'meta',
      'content',
      'more',
    ]);
  });
});

describe('maxStallRetries through callModel', () => {
  it('re-issues a request that stalled before content, then succeeds', async () => {
    const first = stalling();
    serve(first, controlledStream(healthyTextEvents('second try')));
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      streamTimeout: RETRY_ONCE,
    });
    const events = settle(drain(result.getFullResponsesStream()));
    const text = settle(result.getText());
    await vi.advanceTimersByTimeAsync(100);

    expect((await text).value).toBe('second try');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    // The stalled attempt was torn down; the winner was not.
    expect(signals[0]?.aborted).toBe(true);
    expect(first.finished).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    // Consumers saw the winning attempt's events exactly once, and none of
    // the discarded attempt's metadata.
    const items = (await events).value?.items ?? [];
    expect(items.filter((e) => e.type === 'response.created')).toHaveLength(1);
    expect(items.filter((e) => e.type === 'response.output_text.delta')).toHaveLength(1);
  });

  it('rethrows the final stall once the budget is exhausted', async () => {
    serve(stalling(), stalling(), stalling());
    const outcome = settle(
      callModel(client, {
        model: 'test-model',
        input: 'hi',
        streamTimeout: RETRY_ONCE,
      }).getText(),
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    const { error } = await outcome;
    expect(error).toBeInstanceOf(StreamStalledError);
    expect(error).toMatchObject({
      phase: 'first_content',
      retryable: true,
    });
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('never retries a stall after content started', async () => {
    serve(
      controlledStream([
        createdEvent(),
        emptyMessageShell(),
        textDelta('partial'),
      ]),
      controlledStream(healthyTextEvents('unused')),
    );
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      streamTimeout: RETRY_ONCE,
    });
    const streamed = settle(drain(result.getTextStream()));
    await vi.advanceTimersByTimeAsync(100);
    const value = (await streamed).value;
    expect(value?.items).toEqual([
      'partial',
    ]);
    expect(value?.error).toMatchObject({
      name: 'StreamStalledError',
      phase: 'between_content',
      retryable: false,
    });
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('retries a stalled follow-up turn in a tool loop', async () => {
    serve(
      controlledStream(
        healthyToolCallEvents('echo', {
          value: 'a',
        }),
      ),
      stalling(),
      controlledStream(healthyTextEvents('done')),
    );
    const outcome = settle(
      callModel(client, {
        model: 'test-model',
        input: 'hi',
        tools: [
          echoTool,
        ] as const,
        streamTimeout: RETRY_ONCE,
      }).getText(),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect((await outcome).value).toBe('done');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);
  });

  it('a user abort while waiting for first content is not retried', async () => {
    const controller = new AbortController();
    serve(stalling(), controlledStream(healthyTextEvents('unused')));
    const outcome = settle(
      callModel(client, {
        model: 'test-model',
        input: 'hi',
        signal: controller.signal,
        streamTimeout: RETRY_ONCE,
      }).getText(),
    );
    await vi.advanceTimersByTimeAsync(50);
    const reason = new Error('user cancelled');
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(500);
    expect((await outcome).error).toBe(reason);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('without firstContentMs, maxStallRetries is a no-op: events flow in real time', async () => {
    const source = controlledStream([
      createdEvent(),
    ]);
    serve(source);
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      streamTimeout: {
        contentIntervalMs: 100,
        maxStallRetries: 3,
      },
    });
    const iterator = result.getFullResponsesStream();
    const first = await iterator.next();
    // Delivered before any content arrived: the stream was not held back.
    expect(first.value?.type).toBe('response.created');
    for (const event of healthyTextEvents('x').slice(1)) {
      source.push(event);
    }
    source.close();
    await drain({
      [Symbol.asyncIterator]: () => iterator,
    });
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });
});

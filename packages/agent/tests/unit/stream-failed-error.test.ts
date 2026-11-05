/**
 * Typed StreamFailedError (DEV-723): `response.failed`, stream-level `error`
 * events, and truncated streams surface the same typed error on every
 * consume path (getText / getResponse, the follow-up pipe, and every stream
 * getter) instead of bare `Error`s or silently-ending iterators.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { StreamFailedError } from '../../src/index.js';
import { callModel } from '../../src/inner-loop/call-model.js';
import type { ModelResult } from '../../src/lib/model-result.js';
import { tool } from '../../src/lib/tool.js';
import {
  closedStream,
  completedEvent,
  createdEvent,
  drain,
  emptyMessageShell,
  errorEvent,
  failedEvent,
  healthyToolCallEvents,
  textDelta,
  textResponse,
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

function respondWith(...streams: models.StreamEvents[][]): void {
  for (const events of streams) {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: closedStream(events),
    });
  }
}

function noToolsRun() {
  return callModel(client, {
    model: 'test-model',
    input: 'hi',
  });
}

function toolsRun() {
  return callModel(client, {
    model: 'test-model',
    input: 'hi',
    tools: [
      echoTool,
    ] as const,
  });
}

type AnyResult = ModelResult<readonly never[]> | ReturnType<typeof toolsRun>;

/** Every consumption surface, each on a fresh run. */
const getters: Array<
  [
    string,
    (r: AnyResult) => Promise<unknown>,
  ]
> = [
  [
    'getText',
    (r) => r.getText(),
  ],
  [
    'getResponse',
    (r) => r.getResponse(),
  ],
  [
    'getTextStream',
    (r) => throwIfDrainFailed(r.getTextStream()),
  ],
  [
    'getFullResponsesStream',
    (r) => throwIfDrainFailed(r.getFullResponsesStream()),
  ],
  [
    'getItemsStream',
    (r) => throwIfDrainFailed(r.getItemsStream()),
  ],
  [
    'getReasoningStream',
    (r) => throwIfDrainFailed(r.getReasoningStream()),
  ],
  [
    'getToolStream',
    (r) => throwIfDrainFailed(r.getToolStream()),
  ],
  [
    'getNewMessagesStream',
    (r) => throwIfDrainFailed(r.getNewMessagesStream()),
  ],
  [
    'getToolCallsStream',
    (r) => throwIfDrainFailed(r.getToolCallsStream()),
  ],
];

async function throwIfDrainFailed(iterable: AsyncIterable<unknown>): Promise<void> {
  const result = await drain(iterable);
  if (result.threw) {
    throw result.error;
  }
}

beforeEach(() => {
  mockBetaResponsesSend.mockReset();
});

describe('StreamFailedError', () => {
  it.each([
    'server_error',
    'server',
    'timeout',
    'rate_limit_exceeded',
    'provider_overloaded',
    'provider_unavailable',
  ])('classifies %s as retryable (as code or errorType)', (code) => {
    expect(
      new StreamFailedError({
        kind: 'error_event',
        message: 'x',
        code,
      }).retryable,
    ).toBe(true);
    expect(
      new StreamFailedError({
        kind: 'response_failed',
        message: 'x',
        errorType: code,
      }).retryable,
    ).toBe(true);
  });

  it('classifies validation failures and truncated streams as non-retryable', () => {
    expect(
      new StreamFailedError({
        kind: 'response_failed',
        message: 'x',
        code: 'invalid_prompt',
      }).retryable,
    ).toBe(false);
    expect(StreamFailedError.fromStreamEnd(null).retryable).toBe(false);
    expect(StreamFailedError.fromStreamEnd(null).kind).toBe('truncated');
  });

  it('fromFailedResponse carries code, errorType and the failed response', () => {
    const event = failedEvent('server_error', 'upstream died', {
      errorType: 'provider_unavailable',
    }) as models.StreamEventsResponseFailed;
    const error = StreamFailedError.fromFailedResponse(event.response);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StreamFailedError');
    expect(error.kind).toBe('response_failed');
    expect(error.code).toBe('server_error');
    expect(error.errorType).toBe('provider_unavailable');
    expect(error.response).toBe(event.response);
    expect(error.message).toBe('Response failed (server_error): upstream died');
    expect(error.retryable).toBe(true);
  });
});

describe('response.failed surfaces as StreamFailedError on every consume path', () => {
  const failed = () => [
    createdEvent(),
    textDelta('partial'),
    failedEvent('invalid_prompt', 'bad prompt'),
  ];

  it.each(getters)('no tools: %s rejects', async (_name, consume) => {
    respondWith(failed());
    const error = await consume(noToolsRun()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StreamFailedError);
    expect(error).toMatchObject({
      kind: 'response_failed',
      code: 'invalid_prompt',
      retryable: false,
    });
  });

  it.each(getters)('tools, initial turn: %s rejects', async (_name, consume) => {
    respondWith(failed());
    await expect(consume(toolsRun())).rejects.toBeInstanceOf(StreamFailedError);
  });

  it.each(
    getters.filter(([name]) => name !== 'getToolCallsStream'),
  )('tools, follow-up turn: %s rejects', async (_name, consume) => {
    // getToolCallsStream only reads the initial turn, so it is excluded.
    respondWith(
      healthyToolCallEvents('echo', {
        value: 'a',
      }),
      failed(),
    );
    await expect(consume(toolsRun())).rejects.toMatchObject({
      name: 'StreamFailedError',
      kind: 'response_failed',
      code: 'invalid_prompt',
    });
  });
});

describe('stream-level error events', () => {
  const errorThenClose = () => [
    createdEvent(),
    errorEvent('server_error', 'provider hiccup'),
  ];

  it.each(getters)('no tools: error then close makes %s reject', async (_name, consume) => {
    respondWith(errorThenClose());
    await expect(consume(noToolsRun())).rejects.toMatchObject({
      name: 'StreamFailedError',
      kind: 'error_event',
      code: 'server_error',
      retryable: true,
    });
  });

  it('tools, follow-up turn: error then close rejects with the error event', async () => {
    respondWith(
      healthyToolCallEvents('echo', {
        value: 'a',
      }),
      errorThenClose(),
    );
    await expect(toolsRun().getText()).rejects.toMatchObject({
      name: 'StreamFailedError',
      kind: 'error_event',
      message: 'Stream error (server_error): provider hiccup',
    });
  });

  it('an error event followed by a completion still resolves', async () => {
    respondWith([
      createdEvent(),
      errorEvent('server_error', 'transient'),
      emptyMessageShell(),
      textDelta('recovered'),
      completedEvent(textResponse('recovered')),
    ]);
    await expect(noToolsRun().getText()).resolves.toBe('recovered');
  });

  it('keeps the error event with streamReplay: active-consumers', async () => {
    // An error then close must still name the error event even though
    // active-consumers replay drops consumed events before the run
    // materializes the initial response.
    respondWith(errorThenClose());
    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        echoTool,
      ] as const,
      streamReplay: 'active-consumers',
    });
    const drained = await drain(result.getFullResponsesStream());
    expect(drained.error).toMatchObject({
      name: 'StreamFailedError',
      kind: 'error_event',
    });
  });
});

describe('truncated streams (no terminal event)', () => {
  const truncated = () => [
    createdEvent(),
    emptyMessageShell(),
    textDelta('cut off mid-'),
  ];

  it.each(getters)('no tools: %s rejects with kind truncated', async (_name, consume) => {
    respondWith(truncated());
    await expect(consume(noToolsRun())).rejects.toMatchObject({
      name: 'StreamFailedError',
      kind: 'truncated',
      code: null,
      retryable: false,
    });
  });

  it('getTextStream still yields the partial text before rejecting', async () => {
    respondWith(truncated());
    const drained = await drain(noToolsRun().getTextStream());
    expect(drained.items).toEqual([
      'cut off mid-',
    ]);
    expect(drained.error).toBeInstanceOf(StreamFailedError);
  });

  it('breaking out of a getter early is not a failure', async () => {
    respondWith(truncated());
    const result = noToolsRun();
    for await (const _delta of result.getTextStream()) {
      break;
    }
  });

  it('a cancelled run does not report its stream as truncated', async () => {
    respondWith(truncated());
    const result = noToolsRun();
    const iterator = result.getFullResponsesStream();
    await iterator.next();
    await result.cancel();
    const rest = await drain(iterator);
    expect(rest.threw).toBe(false);
  });
});

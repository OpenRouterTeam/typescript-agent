/**
 * Tests for run-level cancellation and per-request timeout composition
 * (`signal` on callModel + RequestOptions.timeoutMs threading).
 *
 * The flake investigation behind this (DEV-658 e2e) found that a stalled
 * provider request hung until the OUTER test timeout because the loop never
 * bounded individual dispatches: `RequestOptions.timeoutMs` was passed
 * through, but supplying any `signal` silently disables the SDK's own
 * timeout wiring, and there was no run-level cancellation at all. These
 * tests pin the composed behavior:
 *
 * - every dispatch (initial, follow-up, final, retry) carries an abort
 *   signal composing {run signal, caller signal, timeoutMs}
 * - aborting the run signal rejects the run with the abort reason, both
 *   between requests and for in-flight requests
 * - `timeoutMs` still bounds each request even when a run signal is present
 *   (the SDK-disabling case), counted per-request, not per-run
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
import { tool } from '../../src/lib/tool.js';

let counter = 0;

function baseResponse(output: unknown[]): models.OpenResponsesResult {
  counter++;
  return {
    id: `resp_${counter}`,
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

function toolCallTurn(name: string, args: unknown): models.OpenResponsesResult {
  counter++;
  return baseResponse([
    {
      type: 'function_call',
      id: `fc_${counter}`,
      callId: `call_${counter}`,
      name,
      arguments: JSON.stringify(args),
      status: 'completed',
    },
  ]);
}

function textTurn(text: string): models.OpenResponsesResult {
  counter++;
  return baseResponse([
    {
      id: `msg_${counter}`,
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

/** The RequestOptions object passed to dispatch N (0-based). */
function dispatchOptions(n: number): {
  signal?: AbortSignal;
  timeoutMs?: number;
} {
  return mockBetaResponsesSend.mock.calls[n]?.[2] ?? {};
}

beforeEach(() => {
  mockBetaResponsesSend.mockReset();
  counter = 0;
});

describe('run-level signal (callModel `signal`)', () => {
  it('threads a composed abort signal into every dispatch', async () => {
    const controller = new AbortController();
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallTurn('echo', {
          value: 'a',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textTurn('done'),
      });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        echoTool,
      ] as const,
      signal: controller.signal,
    }).getText();

    expect(text).toBe('done');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    for (const n of [
      0,
      1,
    ]) {
      expect(dispatchOptions(n).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('a pre-aborted signal fails the run before any network dispatch', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);

    await expect(
      callModel(client, {
        model: 'test-model',
        input: 'go',
        signal: controller.signal,
      }).getText(),
    ).rejects.toBe(reason);

    expect(mockBetaResponsesSend).not.toHaveBeenCalled();
  });

  it('aborting between requests stops the loop with the abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('operator cancelled');

    mockBetaResponsesSend.mockImplementation(async (_client, _req, options) => {
      // First request succeeds and returns a tool call; the tool execution
      // aborts the run, so the loop must stop BEFORE dispatching request 2.
      expect(options?.signal?.aborted).toBe(false);
      return {
        ok: true,
        value: toolCallTurn('echo', {
          value: 'x',
        }),
      };
    });

    const abortingTool = tool({
      name: 'echo',
      inputSchema: z.object({
        value: z.string(),
      }),
      outputSchema: z.object({
        echoed: z.string(),
      }),
      execute: async ({ value }) => {
        controller.abort(reason);
        return {
          echoed: value,
        };
      },
    });

    await expect(
      callModel(client, {
        model: 'test-model',
        input: 'go',
        tools: [
          abortingTool,
        ] as const,
        signal: controller.signal,
      }).getText(),
    ).rejects.toBe(reason);

    // Only the initial request went out; the follow-up was never dispatched.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
  });

  it('aborting mid-request aborts the dispatch signal (fail-fast on a stalled provider)', async () => {
    const controller = new AbortController();
    const reason = new Error('stalled; giving up');

    mockBetaResponsesSend.mockImplementation(
      (
        _client,
        _req,
        options: {
          signal?: AbortSignal;
        },
      ) => {
        // Simulate a hung provider: never resolve, only observe the abort.
        const { promise, reject } = Promise.withResolvers<never>();
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
        return promise;
      },
    );

    const run = callModel(client, {
      model: 'test-model',
      input: 'go',
      signal: controller.signal,
    }).getText();

    // Abort while the request is in flight.
    queueMicrotask(() => controller.abort(reason));

    await expect(run).rejects.toBe(reason);
  });
});

describe('per-request timeoutMs composition', () => {
  it('timeoutMs alone passes through untouched (SDK wires its own timeout)', async () => {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: textTurn('ok'),
    });

    await callModel(
      client,
      {
        model: 'test-model',
        input: 'go',
      },
      {
        timeoutMs: 5000,
      },
    ).getText();

    const options = dispatchOptions(0);
    expect(options.timeoutMs).toBe(5000);
    // No run signal ⇒ no composition; the SDK sees no signal and applies
    // timeoutMs itself.
    expect(options.signal).toBeUndefined();
  });

  // NOTE on real timers (documented exception to the fake-timer rule): the
  // engine's per-request timeout is AbortSignal.timeout(), which runs on
  // Node-internal timers that vitest fake timers cannot fake. Faking the
  // mockable globals while AbortSignal.timeout stays real would make these
  // tests pass vacuously (near-zero real time elapses, so a WRONG shared
  // per-run timer would never fire either). Budgets are kept tiny (≤150ms)
  // so the suite stays fast, and assertions are on outcomes, not timings.
  it('timeoutMs STILL bounds each request when a run signal is present', async () => {
    // The SDK skips its timeoutMs wiring whenever a signal is supplied —
    // the engine must re-create the timeout inside the composed signal or
    // the caller's timeout would be silently dropped.
    const controller = new AbortController();

    mockBetaResponsesSend.mockImplementation(
      (
        _client,
        _req,
        options: {
          signal?: AbortSignal;
        },
      ) => {
        // Hung provider; only the composed timeout can end this.
        const { promise, reject } = Promise.withResolvers<never>();
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
        return promise;
      },
    );

    await expect(
      callModel(
        client,
        {
          model: 'test-model',
          input: 'go',
          signal: controller.signal,
        },
        {
          timeoutMs: 50,
        },
      ).getText(),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('the composed timeout is created per dispatch, not shared across turns', async () => {
    // Two sequential requests, each taking ~66% of the timeout budget
    // (80ms of 120ms): a SHARED per-run timer would fire during request 2
    // and reject the run; per-dispatch timers never fire and the run
    // completes. Real delays are required — see the note above — and are
    // the discriminating variable here, not a race guess.
    const controller = new AbortController();
    let call = 0;
    mockBetaResponsesSend.mockImplementation(
      (
        _client,
        _req,
        options: {
          signal?: AbortSignal;
        },
      ) => {
        call++;
        const value =
          call === 1
            ? toolCallTurn('echo', {
                value: 'x',
              })
            : textTurn('done');
        const { promise, resolve, reject } = Promise.withResolvers<{
          ok: true;
          value: models.OpenResponsesResult;
        }>();
        const timer = setTimeout(
          () =>
            resolve({
              ok: true,
              value,
            }),
          80,
        );
        options.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(options.signal?.reason);
          },
          {
            once: true,
          },
        );
        return promise;
      },
    );

    const text = await callModel(
      client,
      {
        model: 'test-model',
        input: 'go',
        tools: [
          echoTool,
        ] as const,
        signal: controller.signal,
      },
      {
        timeoutMs: 120,
      },
    ).getText();

    expect(text).toBe('done');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });
});

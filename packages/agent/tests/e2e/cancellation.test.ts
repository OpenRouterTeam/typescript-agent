/**
 * E2E tests for run cancellation and per-request timeouts against the LIVE
 * OpenRouter transport.
 *
 * The unit suite (tests/unit/run-cancellation.test.ts) pins the composition
 * semantics against mocks; these tests prove the part mocks cannot: the
 * composed abort signal actually reaches the real fetch/stream, so an abort
 * or per-request timeout fails a genuinely in-flight request in seconds
 * instead of hanging until the full generation completes. That fail-fast
 * property is what deflaked the DEV-658 test — this file keeps it validated
 * in CI.
 *
 * Timing note: these assert generous wall-clock BOUNDS (e.g. "settled in
 * <15s where the un-aborted generation takes 20s+"), never exact durations,
 * so provider variance cannot flake them. Real timers are unavoidable here:
 * fake timers cannot drive a live network exchange.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { OpenRouter, ToolType } from '../../src/index.js';

describe('run cancellation E2E', () => {
  let client: OpenRouter;

  beforeAll(() => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY environment variable is required for e2e tests');
    }
    client = new OpenRouter({
      apiKey,
    });
  });

  // A prompt whose generation reliably takes far longer than every bound
  // asserted below, so "settled fast" can only mean the abort/timeout
  // actually cut the live request short.
  const LONG_GENERATION_PROMPT =
    'Write a detailed 2000-word essay on the history of transatlantic shipping. Do not summarize; write the full essay.';

  it('a pre-aborted signal fails before any network dispatch', {
    timeout: 15000,
  }, async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);

    const startedAt = performance.now();
    await expect(
      client
        .callModel({
          model: 'anthropic/claude-haiku-4.5',
          input: LONG_GENERATION_PROMPT,
          signal: controller.signal,
        })
        .getText(),
    ).rejects.toBe(reason);

    // No dispatch happened: settling is near-instant, not a network RTT.
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it('aborting the run signal kills a live in-flight generation fast', {
    timeout: 30000,
    retry: 1,
  }, async () => {
    const controller = new AbortController();
    const reason = new Error('operator cancelled mid-flight');

    const response = client.callModel({
      model: 'anthropic/claude-haiku-4.5',
      input: LONG_GENERATION_PROMPT,
      signal: controller.signal,
    });
    const run = response.getText();

    // Real timer, deliberately: we are validating live-transport abort
    // behavior, which fake timers cannot exercise. 1500ms is long enough
    // for the request to be genuinely in flight (dispatch + first tokens)
    // and far shorter than the ~20s+ full generation.
    const abortTimer = setTimeout(() => controller.abort(reason), 1500);

    const startedAt = performance.now();
    try {
      await expect(run).rejects.toThrow();
    } finally {
      clearTimeout(abortTimer);
    }
    const elapsed = performance.now() - startedAt;

    // The contract under test: fail-fast. Without the composed signal
    // reaching the fetch, this would resolve (or hang) only after the
    // full essay generation. 15s is a generous ceiling with a wide margin
    // on both sides of the 1.5s abort.
    expect(elapsed).toBeLessThan(15000);
  });

  it('per-request timeoutMs bounds a live request even when a run signal is present', {
    timeout: 30000,
    retry: 1,
  }, async () => {
    // The SDK skips its own timeoutMs wiring when a signal is supplied —
    // this exercises the engine's re-composition against the real
    // transport (the exact configuration the DEV-658 test now relies on).
    const controller = new AbortController(); // never aborted

    const startedAt = performance.now();
    await expect(
      client
        .callModel(
          {
            model: 'anthropic/claude-haiku-4.5',
            input: LONG_GENERATION_PROMPT,
            signal: controller.signal,
          },
          {
            timeoutMs: 2500,
          },
        )
        .getText(),
    ).rejects.toThrow();
    const elapsed = performance.now() - startedAt;

    // Must settle near the 2.5s timeout, not after the full generation.
    expect(elapsed).toBeLessThan(15000);
    // And not BEFORE the timeout could have fired (guards against the
    // request failing for an unrelated reason and passing vacuously).
    expect(elapsed).toBeGreaterThanOrEqual(2000);
  });

  it('aborting during tool execution stops the loop before the follow-up dispatch', {
    timeout: 30000,
    retry: 1,
  }, async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled during tool execution');

    const weatherTool = {
      type: ToolType.Function,
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a location.',
        inputSchema: z.object({
          location: z.string(),
        }),
        outputSchema: z.object({
          temperature: z.number(),
        }),
        execute: async (_params: { location: string }) => {
          // Abort mid-run, between the initial request and the follow-up.
          controller.abort(reason);
          return {
            temperature: 22,
          };
        },
      },
    } as const;

    // toolChoice 'required' forces the tool call, so the abort point is
    // reached deterministically regardless of model mood.
    await expect(
      client
        .callModel({
          model: 'anthropic/claude-haiku-4.5',
          instructions: 'You are a weather assistant. Always call get_weather when asked.',
          input: "What's the weather in Tokyo?",
          toolChoice: 'required',
          tools: [
            weatherTool,
          ] as const,
          signal: controller.signal,
        })
        .getText(),
    ).rejects.toBe(reason);
  });

  it('a run with both bounds set completes normally when neither fires', {
    timeout: 30000,
    retry: 1,
  }, async () => {
    // Sanity for the composition path: a composed AbortSignal.any signal
    // must not break normal streaming completion on the live transport.
    const controller = new AbortController();

    const text = await client
      .callModel(
        {
          model: 'anthropic/claude-haiku-4.5',
          input: "Say 'composed-bounds test' and nothing else.",
          signal: controller.signal,
        },
        {
          timeoutMs: 25000,
        },
      )
      .getText();

    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});

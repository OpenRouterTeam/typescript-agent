/**
 * Compile-verified, every-field examples for the PR description. Each
 * example exercises the COMPLETE config surface of its tool kind — if a
 * field is renamed or removed, this file fails typecheck and the PR docs
 * are known-stale.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod/v4';
import { callModel, stepCountIs } from '../../src/index.js';
import { tool } from '../../src/lib/tool.js';
import type { StateAccessor, Tool } from '../../src/lib/tool-types.js';

declare const client: OpenRouterCore;
declare const makeAccessor: (conversationId: string) => StateAccessor;
declare const renderer: {
  start: (
    script: string,
    opts: {
      signal?: AbortSignal;
      quality: string;
    },
  ) => Promise<{
    progress: () => AsyncIterable<number>;
    reprioritize: (msg: unknown) => void;
    result: () => Promise<{
      url: string;
      durationMs: number;
    }>;
  }>;
};
declare const legal: {
  open: (
    contractId: string,
    opts: {
      conversationId?: string;
      urgency: string;
    },
  ) => Promise<{
    id: string;
  }>;
  cachedVerdict: (contractId: string) => Promise<{
    approved: boolean;
    notes?: string;
  } | null>;
};
declare const search: {
  query: (q: string) => Promise<string[]>;
};

describe('full-field examples (PR documentation, compile-verified)', () => {
  // ─── Example 1: background tool — every field ────────────────────────────
  const renderVideo = tool({
    // Identity
    name: 'render_video',
    description: 'Render a video from a script. Long-running; returns a task handle.',

    // Lifecycle: 'sync' (default) | 'background' | 'deferred'
    lifecycle: 'background',

    // Schemas
    inputSchema: z.object({
      script: z.string().describe('The video script'),
      quality: z
        .enum([
          'draft',
          'production',
        ])
        .default('draft'),
    }),
    outputSchema: z.object({
      url: z.string(),
      durationMs: z.number(),
    }),
    eventSchema: z.object({
      pct: z.number().min(0).max(100),
    }),

    // Context: typed per-tool data supplied via callModel({ context })
    contextSchema: z.object({
      apiKey: z.string(),
    }),

    // Async behavior
    ack: ({ quality }) => `Started a ${quality} render.`, // string | object | (input) => …
    graceMs: 250, //     settles this fast → plain sync output, no placeholder
    timeoutMs: 300_000, // whole-task deadline; ctx.signal aborts on breach
    maxConcurrency: 2, // max simultaneous renders across the run
    logLimits: {
      maxEntries: 500,
      maxBytes: 512_000,
      maxEntryBytes: 2_000,
    },

    // Model-side task interactions (via the universal `task` tool):
    // custom params validated by `schema`, handled by `execute`.
    check: {
      schema: z.object({
        includeFrames: z.boolean().optional(),
      }),
      execute: async (params, turnContext) => {
        // Matt's turn-context fields, verbatim:
        const state = turnContext.toolCallStatus; //   'working' | 'completed' | …
        const yieldsSoFar = turnContext.accumulatedYieldedEvents; // every run yield
        const handle = turnContext.task; //             statusView/tailLogs/transcript/send/cancel
        return {
          state,
          progressEvents: yieldsSoFar?.length ?? 0,
          ...(params['includeFrames'] === true && {
            lastFrames: handle?.tailLogs(3),
          }),
        };
      },
    },

    // Loop integration
    requireApproval: ({ quality }) => quality === 'production',
    loopKey: [
      'script',
    ], // doom-loop identity = script only (quality changes ≠ new work)
    nextTurnParams: {
      temperature: (_input, _ctx) => 0.2,
    },
    toModelOutput: ({ output }) => ({
      type: 'content',
      value: [
        {
          type: 'input_text',
          text: `Video ready: ${output.url}`,
        },
      ],
    }),

    // The handler: async generator — yields = task log + preliminary events,
    // return = final result (validated against outputSchema).
    run: async function* ({ script, quality }, ctx) {
      ctx?.local.apiKey; //                      typed by contextSchema
      ctx?.onMessage((msg) => job.reprioritize(msg)); // steering inbox
      ctx?.log('warming up render farm'); //     non-yield logging
      const job = await renderer.start(script, {
        signal: ctx?.signal, //                  fires on timeout/cancel/abort
        quality,
      });
      for await (const pct of job.progress()) {
        yield {
          pct,
        }; //                                    validated by eventSchema
      }
      return job.result(); //                    validated by outputSchema
    },
  });

  // ─── Example 2: deferred tool — every field + completion methods ─────────
  const legalReview = tool({
    name: 'request_legal_review',
    description: 'Send a contract for legal review. Pauses until the webhook resolves it.',
    lifecycle: 'deferred',
    inputSchema: z.object({
      contractId: z.string(),
      urgency: z
        .enum([
          'normal',
          'high',
        ])
        .default('normal'),
    }),
    outputSchema: z.object({
      approved: z.boolean(),
      notes: z.string().optional(),
    }),
    ack: 'Legal review requested.',
    pollAfterMs: 60_000, // hint surfaced in the placeholder + status views
    timeoutMs: 10_000, //  bounds run() itself (opening the ticket), not the review
    check: {
      execute: async (_params, turnContext) =>
        // Custom status for external tasks; default views also available.
        ({
          state: turnContext.toolCallStatus,
          note: 'Reviews take 1-3 business days.',
        }),
    },
    run: async ({ contractId, urgency }, ctx) => {
      // Typed fast path: plain return = immediate result.
      const cached = await legal.cachedVerdict(contractId);
      if (cached) {
        return cached;
      }
      // Durable pause: ctx.defer parks the call until .resolve()/.fail()/.cancel().
      const ticket = await legal.open(contractId, {
        conversationId: ctx?.conversationId, // hand to the webhook for resume
        urgency,
      });
      if (!ctx) {
        throw new Error('deferred tools require the run context');
      }
      return ctx.defer(ticket.id, {
        pollAfterMs: urgency === 'high' ? 15_000 : 60_000,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        ack: `Ticket ${ticket.id} opened (${urgency}).`,
      });
    },
  });

  // ─── Example 3: agent tool — every field ─────────────────────────────────
  const childSearch = tool({
    name: 'web_search',
    inputSchema: z.object({
      q: z.string(),
    }),
    run: async ({ q }) => ({
      results: await search.query(q),
    }),
  });

  const researcher = tool.agent({
    name: 'research_topic',
    description: 'Deep-research a topic as a background subagent.',
    inputSchema: z.object({
      topic: z.string(),
      depth: z.number().int().min(1).max(20).default(5),
    }),
    outputSchema: z.object({
      text: z.string(),
      sources: z.array(z.string()),
    }),
    // The child conversation spec, built per call:
    agent: ({ topic, depth }) => ({
      model: 'openai/gpt-4o',
      instructions: 'You are a thorough researcher. Cite sources.',
      input: `Research: ${topic}`,
      tools: [
        childSearch,
      ] as const,
      stopWhen: stepCountIs(depth),
      // Child-scoped hooks are allowed here; the PARENT's hooks are never
      // inherited. `state`/`signal` are engine-controlled and excluded.
    }),
    // Map the finished child run to this tool's output (default: last-message
    // text as { text }):
    result: async (child) => ({
      text: await child.getText(),
      sources: (await child.getToolCalls()).map((c) => JSON.stringify(c.arguments)),
    }),
    ack: 'Research started.',
    graceMs: 0, //         always placeholder (children are never that fast)
    timeoutMs: 600_000, //  whole child run
    maxConcurrency: 3, //   max concurrent child conversations for this tool
    requireApproval: false,
    loopKey: [
      'topic',
    ],
  });

  // ─── Example 4: the run itself — every run-level option ──────────────────
  it('everything composes into callModel with full typing', () => {
    const state = makeAccessor('conv_123');
    const result = callModel(client, {
      model: 'openai/gpt-4o',
      input: 'Render the explainer, get it approved, and research the market',
      tools: [
        renderVideo,
        legalReview,
        researcher,
      ] as const,
      state,
      context: {
        render_video: {
          apiKey: 'rk_…',
        },
        request_legal_review: {},
        research_topic: {},
        web_search: {},
      },
      toolTimeoutMs: 60_000, //          run-default per-tool deadline
      toolConcurrency: {
        round: 4, //                     max simultaneous calls per round
        background: 8, //                max detached background tasks
      },
      asyncTools: {
        onRunEnd: 'drain', //            'drain' | 'detach' | 'cancel'
        drainTimeoutMs: 30_000,
        maxDrainTurns: 2,
        checkins: true, //               register the universal `task` tool
        maxTranscriptChars: 20_000, //   transcript view cap
      },
      doomLoop: true,
      stopWhen: stepCountIs(25),
    });

    // Developer-side task control:
    expectTypeOf(result.getAsyncTasks).returns.items.toHaveProperty('taskId');
    expectTypeOf(result.sendToTask).parameters.toEqualTypeOf<
      [
        string,
        unknown,
      ]
    >();
    expectTypeOf(result.cancelTask).returns.toEqualTypeOf<boolean>();
  });

  // ─── Example 5: deferred completion — typed, cross-process ───────────────
  it('deferred completion methods are typed by outputSchema', () => {
    // legalReview.resolve / .fail / .cancel — callable from a webhook in a
    // different process, `output` checked against outputSchema.
    expectTypeOf(legalReview.resolve).parameter(1).toHaveProperty('output').toEqualTypeOf<{
      approved: boolean;
      notes?: string | undefined;
    }>();
    expectTypeOf(legalReview.fail).parameter(1).toHaveProperty('error');
    expectTypeOf(legalReview.cancel).parameter(1).toHaveProperty('taskId');
  });

  it('all three examples are assignable to Tool[]', () => {
    const tools = [
      renderVideo,
      legalReview,
      researcher,
      childSearch,
    ] as const;
    expectTypeOf(tools).toExtend<readonly Tool[]>();
  });
});

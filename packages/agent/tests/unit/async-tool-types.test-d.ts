import type { OpenRouterCore } from '@openrouter/sdk/core';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod/v4';
import type { ModelResult } from '../../src/lib/model-result.js';
import { tool } from '../../src/lib/tool.js';
import type { StateAccessor, Tool } from '../../src/lib/tool-types.js';

describe('async tool type inference', () => {
  const legalReview = tool.deferred({
    name: 'request_legal_review',
    inputSchema: z.object({
      contractId: z.string(),
    }),
    outputSchema: z.object({
      approved: z.boolean(),
      notes: z.string().optional(),
    }),
    start: async ({ contractId }) => {
      expectTypeOf(contractId).toEqualTypeOf<string>();
      return {
        taskId: 'ticket_1',
      };
    },
  });

  it('deferred .resolve() output is typed by outputSchema', () => {
    type ResolveParams = Parameters<typeof legalReview.resolve>[1];
    expectTypeOf<ResolveParams['output']>().toEqualTypeOf<{
      approved: boolean;
      notes?: string | undefined;
    }>();
    expectTypeOf<ResolveParams['taskId']>().toEqualTypeOf<string>();
    expectTypeOf<ResolveParams['state']>().toEqualTypeOf<StateAccessor<readonly Tool[]>>();
    expectTypeOf(legalReview.resolve).returns.toEqualTypeOf<
      Promise<ModelResult<readonly Tool[]> | null>
    >();
  });

  it('deferred tools are assignable to Tool[] alongside other kinds', () => {
    const regular = tool({
      name: 'regular',
      inputSchema: z.object({
        q: z.string(),
      }),
      execute: async ({ q }) => ({
        echoed: q,
      }),
    });
    const background = tool.background({
      name: 'bg',
      inputSchema: z.object({
        s: z.string(),
      }),
      outputSchema: z.object({
        url: z.string(),
      }),
      execute: async () => ({
        url: 'x',
      }),
    });

    const tools = [
      regular,
      background,
      legalReview,
    ] as const;
    expectTypeOf(tools).toExtend<readonly Tool[]>();
  });

  it('background execute return type must match outputSchema', () => {
    tool.background({
      name: 'typed_bg',
      inputSchema: z.object({}),
      outputSchema: z.object({
        url: z.string(),
      }),
      // @ts-expect-error — wrong return shape
      execute: async () => ({
        wrong: true,
      }),
    });
  });

  it('deferred start return type is constrained to taskId or typed output', () => {
    tool.deferred({
      name: 'typed_deferred',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      // @ts-expect-error — output must match outputSchema
      start: async () => ({
        output: {
          ok: 'yes',
        },
      }),
    });
  });

  it('background ctx exposes signal and progress typed by eventSchema', () => {
    tool.background({
      name: 'ctx_probe',
      inputSchema: z.object({}),
      eventSchema: z.object({
        pct: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      execute: async (_params, ctx) => {
        if (ctx) {
          expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
          expectTypeOf(ctx.progress).parameter(0).toEqualTypeOf<{
            pct: number;
          }>();
        }
        return {
          ok: true,
        };
      },
    });
  });

  it('resolve/fail/cancel accept an OpenRouterCore client', () => {
    expectTypeOf(legalReview.resolve).parameter(0).toEqualTypeOf<OpenRouterCore>();
    expectTypeOf(legalReview.fail).parameter(0).toEqualTypeOf<OpenRouterCore>();
    expectTypeOf(legalReview.cancel).parameter(0).toEqualTypeOf<OpenRouterCore>();
  });
});

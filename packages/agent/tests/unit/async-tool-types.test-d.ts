import type { OpenRouterCore } from '@openrouter/sdk/core';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod/v4';
import type { ModelResult } from '../../src/lib/model-result.js';
import { tool } from '../../src/lib/tool.js';
import type { StateAccessor, Tool } from '../../src/lib/tool-types.js';

describe('async tool type inference', () => {
  const legalReview = tool({
    name: 'request_legal_review',
    lifecycle: 'deferred',
    inputSchema: z.object({
      contractId: z.string(),
    }),
    outputSchema: z.object({
      approved: z.boolean(),
      notes: z.string().optional(),
    }),
    run: async ({ contractId }, ctx) => {
      expectTypeOf(contractId).toEqualTypeOf<string>();
      if (!ctx) {
        throw new Error('no ctx');
      }
      return ctx.defer('ticket_1');
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
    const background = tool({
      name: 'bg',
      lifecycle: 'background',
      inputSchema: z.object({
        s: z.string(),
      }),
      outputSchema: z.object({
        url: z.string(),
      }),
      run: async () => ({
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

  it('background run return type must match outputSchema', () => {
    tool({
      name: 'typed_bg',
      lifecycle: 'background',
      inputSchema: z.object({}),
      outputSchema: z.object({
        url: z.string(),
      }),
      // @ts-expect-error — wrong return shape
      run: async () => ({
        wrong: true,
      }),
    });
  });

  it('deferred run return type is constrained to DeferredHandle or typed output', () => {
    tool({
      name: 'typed_deferred',
      lifecycle: 'deferred',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      // @ts-expect-error — output must match outputSchema
      run: async () => ({
        ok: 'yes',
      }),
    });
  });

  it('background run ctx exposes signal, log, and onMessage', () => {
    tool({
      name: 'ctx_probe',
      lifecycle: 'background',
      inputSchema: z.object({}),
      eventSchema: z.object({
        pct: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      run: async (_params, ctx) => {
        if (ctx) {
          expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
          expectTypeOf(ctx.log).parameter(0).toEqualTypeOf<unknown>();
          expectTypeOf(ctx.onMessage).parameter(0).toEqualTypeOf<(message: unknown) => void>();
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

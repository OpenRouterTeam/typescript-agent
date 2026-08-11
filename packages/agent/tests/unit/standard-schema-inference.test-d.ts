import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import type { InferToolInput } from '../../src/lib/tool-types.js';

const standardTool = tool({
  name: 'standard',
  inputSchema: v.object({
    value: v.pipe(
      v.string(),
      v.transform((value) => value.length),
    ),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      value: {
        type: 'string',
      },
    },
    required: [
      'value',
    ],
  },
  outputSchema: v.object({
    ok: v.boolean(),
  }),
  eventSchema: v.object({
    progress: v.number(),
  }),
  contextSchema: v.object({
    token: v.string(),
  }),
  execute: async function* ({ value }, ctx) {
    expectTypeOf(value).toEqualTypeOf<number>();
    expectTypeOf(ctx!.local.token).toEqualTypeOf<string>();
    yield {
      progress: value,
    };
    return {
      ok: true,
    };
  },
  toModelOutput: ({ output, input }) => {
    expectTypeOf(output).toEqualTypeOf<{
      ok: boolean;
    }>();
    expectTypeOf(input).toEqualTypeOf<{
      value: number;
    }>();
    return {
      type: 'content',
      value: [],
    };
  },
});

expectTypeOf<InferToolInput<typeof standardTool>>().toEqualTypeOf<{
  value: number;
}>();

const zodTool = tool({
  name: 'zod',
  inputSchema: z.object({
    value: z.string(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
  }),
  execute: ({ value }) => {
    expectTypeOf(value).toEqualTypeOf<string>();
    return {
      ok: true,
    };
  },
});

expectTypeOf<InferToolInput<typeof zodTool>>().toEqualTypeOf<{
  value: string;
}>();
expectTypeOf(zodTool.function.execute).parameter(0).toEqualTypeOf<{
  value: string;
}>();

import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import type { InferToolInput } from '../../src/lib/tool-types.js';

const valibotInputSchema = v.object({
  value: v.string(),
});

// A validator implementing Standard Schema v1 but with no way to produce a
// JSON Schema (valibot >= 1.4 carries the StandardJSONSchemaV1 trait natively,
// so it no longer exercises this path). The model-facing wire format must be
// supplied explicitly for validation-only schemas.
const validationOnlySchema = {
  '~standard': {
    version: 1 as const,
    validate: (value: unknown) => ({
      value: value as Record<string, unknown>,
    }),
  },
};

const missingInputJsonSchema = tool({
  name: 'missing_json_schema',
  // @ts-expect-error non-Zod input schemas require the provider-facing JSON Schema
  inputSchema: validationOnlySchema,
  execute: (params) => params,
});
void missingInputJsonSchema;

const traitTool = tool({
  name: 'standard_json_schema_trait',
  inputSchema: toStandardJsonSchema(valibotInputSchema),
  execute: ({ value }) => value,
});
expectTypeOf(traitTool.function.execute).parameter(0).toEqualTypeOf<{
  value: string;
}>();

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

// Zod keeps its built-in JSON Schema conversion and needs no inputJsonSchema.
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

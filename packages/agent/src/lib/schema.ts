import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import * as z4 from 'zod/v4';
import type { $ZodObject, $ZodShape, $ZodType, infer as zodInfer } from 'zod/v4/core';

/**
 * Any validator the agent accepts for tool input, output, event, context,
 * shared-context, check, and custom-hook schemas: a Zod v4 schema (kept on
 * the native fast path) or any Standard Schema v1 validator (Valibot,
 * ArkType, Effect Schema, ...).
 */
export type Schema<Input = unknown, Output = Input> =
  | $ZodType<Output, Input>
  | StandardSchemaV1<Input, Output>;

/** A {@link Schema} whose validated output is an object shape. */
export type ObjectSchema =
  | $ZodObject<$ZodShape>
  | StandardSchemaV1<unknown, Record<string, unknown>>;

/**
 * Tool config shape for the input schema. `inputJsonSchema` — the JSON
 * Schema sent to the model — is optional when the validator can produce one
 * itself (Zod via z.toJSONSchema, or the StandardJSONSchemaV1 trait) and
 * required at compile time for validation-only non-Zod input schemas. When
 * supplied it always wins.
 */
export type InputSchemaConfig<TInput extends ObjectSchema> = {
  inputSchema: TInput;
} & (TInput extends $ZodObject<$ZodShape> | StandardJSONSchemaV1
  ? {
      inputJsonSchema?: Record<string, unknown>;
    }
  : {
      inputJsonSchema: Record<string, unknown>;
    });

/** Infer the input (pre-validation) type of a Zod or Standard Schema v1 schema. */
export type InferSchemaInput<TSchema> = TSchema extends $ZodType
  ? TSchema['_zod']['input']
  : TSchema extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<TSchema>
    : unknown;

/** Infer the output (post-validation) type of a Zod or Standard Schema v1 schema. */
export type InferSchemaOutput<TSchema> = TSchema extends $ZodType
  ? zodInfer<TSchema>
  : TSchema extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<TSchema>
    : unknown;

/** A single normalized Standard Schema validation issue. */
export interface SchemaIssue {
  readonly message: string;
  readonly path: PropertyKey[];
}

/**
 * Error thrown when a Standard Schema v1 validator rejects a value. Issues
 * are normalized to the same `{ message, path }` shape the agent surfaces
 * for Zod validation errors.
 */
export class StandardSchemaError extends Error {
  readonly issues: SchemaIssue[];

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    const normalized = issues.map((issue) => ({
      message: issue.message,
      path: (issue.path ?? []).map((segment) =>
        typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment,
      ),
    }));
    super(JSON.stringify(normalized));
    this.name = 'StandardSchemaError';
    this.issues = normalized;
  }
}

export function isZodSchema(schema: unknown): schema is $ZodType {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '_zod' in schema &&
    typeof schema._zod === 'object'
  );
}

export function tryStandardJsonSchema(
  schema: unknown,
  target: StandardJSONSchemaV1.Target,
): Record<string, unknown> | undefined {
  if (typeof schema !== 'object' || schema === null || !('~standard' in schema)) {
    return undefined;
  }
  const standard = schema['~standard'] as {
    jsonSchema?: {
      input?: unknown;
    };
  };
  if (typeof standard.jsonSchema?.input !== 'function') {
    return undefined;
  }
  try {
    return (standard.jsonSchema.input as StandardJSONSchemaV1.Converter['input'])({
      target,
    });
  } catch {
    return undefined;
  }
}

function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
  if (typeof schema !== 'object' || schema === null || !('~standard' in schema)) {
    return false;
  }
  const standard = schema['~standard'] as {
    version?: unknown;
    validate?: unknown;
  };
  return standard.version === 1 && typeof standard.validate === 'function';
}

export async function validateSchema<TSchema extends Schema>(
  schema: TSchema,
  value: unknown,
): Promise<InferSchemaOutput<TSchema>> {
  if (isZodSchema(schema)) {
    return z4.parse(schema, value) as InferSchemaOutput<TSchema>;
  }
  if (!isStandardSchema(schema)) {
    throw new Error('Invalid Standard Schema v1 validator provided');
  }
  const result = await schema['~standard'].validate(value);
  if (result.issues) {
    throw new StandardSchemaError(result.issues);
  }
  return result.value as InferSchemaOutput<TSchema>;
}

export function validateSchemaSync<TSchema extends Schema>(
  schema: TSchema,
  value: unknown,
): InferSchemaOutput<TSchema> {
  if (isZodSchema(schema)) {
    return z4.parse(schema, value) as InferSchemaOutput<TSchema>;
  }
  if (!isStandardSchema(schema)) {
    throw new Error('Invalid Standard Schema v1 validator provided');
  }
  const result = schema['~standard'].validate(value);
  // Thenable check, not `instanceof Promise`: cross-realm promises and custom
  // thenables must be rejected here too, or they'd pass as a silent success.
  if (result !== null && typeof (result as PromiseLike<unknown>).then === 'function') {
    throw new Error(
      'Async Standard Schema validators are not supported in synchronous validation paths',
    );
  }
  const syncResult = result as StandardSchemaV1.Result<unknown>;
  if (syncResult.issues) {
    throw new StandardSchemaError(syncResult.issues);
  }
  return syncResult.value as InferSchemaOutput<TSchema>;
}

export async function safeValidateSchema<TSchema extends Schema>(
  schema: TSchema,
  value: unknown,
): Promise<
  | {
      success: true;
      data: InferSchemaOutput<TSchema>;
    }
  | {
      success: false;
      error: Error;
    }
> {
  try {
    return {
      success: true,
      data: await validateSchema(schema, value),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Synchronous, non-throwing schema validation for call sites that branch on
 * success/failure (approval gates, pre-tool-use checks). Accepts both Zod v4
 * schemas and Standard Schema v1 validators; async validators are rejected
 * rather than awaited, mirroring {@link validateSchemaSync}.
 */
export function safeParseSchemaSync<TSchema extends Schema>(
  schema: TSchema,
  value: unknown,
):
  | {
      success: true;
      data: InferSchemaOutput<TSchema>;
    }
  | {
      success: false;
      error: unknown;
    } {
  if (isZodSchema(schema)) {
    const parsed = z4.safeParse(schema, value);
    if (parsed.success) {
      return {
        success: true,
        data: parsed.data as InferSchemaOutput<TSchema>,
      };
    }
    return {
      success: false,
      error: parsed.error,
    };
  }
  if (!isStandardSchema(schema)) {
    return {
      success: false,
      error: new Error('Invalid Standard Schema v1 validator provided'),
    };
  }
  const result = schema['~standard'].validate(value);
  if (result !== null && typeof (result as PromiseLike<unknown>).then === 'function') {
    return {
      success: false,
      error: new Error(
        'Async Standard Schema validators are not supported in synchronous validation paths',
      ),
    };
  }
  const syncResult = result as StandardSchemaV1.Result<unknown>;
  if (syncResult.issues) {
    return {
      success: false,
      error: new StandardSchemaError(syncResult.issues),
    };
  }
  return {
    success: true,
    data: syncResult.value as InferSchemaOutput<TSchema>,
  };
}

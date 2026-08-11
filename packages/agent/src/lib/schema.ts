import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import * as z4 from 'zod/v4';
import type { $ZodObject, $ZodShape, $ZodType, infer as zodInfer } from 'zod/v4/core';

export type Schema<Input = unknown, Output = Input> =
  | $ZodType<Output, Input>
  | StandardSchemaV1<Input, Output>;

export type ObjectSchema =
  | $ZodObject<$ZodShape>
  | StandardSchemaV1<unknown, Record<string, unknown>>;

export type InputSchemaConfig<TInput extends ObjectSchema> = {
  inputSchema: TInput;
} & (TInput extends $ZodObject<$ZodShape> | StandardJSONSchemaV1
  ? {
      inputJsonSchema?: Record<string, unknown>;
    }
  : {
      inputJsonSchema: Record<string, unknown>;
    });

export type InferSchemaInput<TSchema> = TSchema extends $ZodType
  ? TSchema['_zod']['input']
  : TSchema extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<TSchema>
    : unknown;

export type InferSchemaOutput<TSchema> = TSchema extends $ZodType
  ? zodInfer<TSchema>
  : TSchema extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<TSchema>
    : unknown;

export interface SchemaIssue {
  readonly message: string;
  readonly path: PropertyKey[];
}

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

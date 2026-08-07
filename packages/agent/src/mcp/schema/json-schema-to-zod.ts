import * as z from 'zod';
import type { $ZodObject, $ZodType } from 'zod/v4/core';
import { MCPError } from '../errors.js';
import { getSchemaProperties, isJsonSchemaObject } from './json-schema-guards.js';

/**
 * How to handle a JSON Schema (sub)schema that Zod cannot represent.
 * - `looseLeaf` (default): substitute `z.unknown()` for only the offending
 *   property so the rest of the tool's parameters stay faithful.
 * - `throw`: surface the conversion failure to the caller.
 */
export type UnconvertibleSchemaMode = 'looseLeaf' | 'throw';

/** Narrow a Zod schema to an object schema via its runtime type tag (no `as`). */
function isZodObject(schema: $ZodType): schema is $ZodObject {
  return schema._zod.def.type === 'object';
}

/** The `required` array of an object schema, filtered to string keys. */
function requiredKeys(schema: Record<string, unknown>): Set<string> {
  const { required } = schema;
  if (!Array.isArray(required)) {
    return new Set();
  }
  return new Set(required.filter((key): key is string => typeof key === 'string'));
}

/**
 * Build a Zod object by converting each property independently, substituting
 * `z.unknown()` for any property Zod cannot represent. Always yields a
 * `$ZodObject`, which is what `callModel`'s `tool()` factory requires.
 */
function buildObjectFromProperties(
  jsonSchema: Record<string, unknown>,
  mode: UnconvertibleSchemaMode,
): $ZodObject {
  const properties = getSchemaProperties(jsonSchema) ?? {};
  const required = requiredKeys(jsonSchema);
  const shape: Record<string, $ZodType> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    let zodProp: $ZodType;
    try {
      zodProp = isJsonSchemaObject(propSchema) ? z.fromJSONSchema(propSchema) : z.unknown();
    } catch (err) {
      if (mode === 'throw') {
        throw new MCPError(`Cannot convert JSON Schema for property "${key}" to Zod`, {
          cause: err,
        });
      }
      zodProp = z.unknown();
    }
    shape[key] = required.has(key) ? zodProp : z.optional(zodProp);
  }

  return z.object(shape);
}

/**
 * Convert an MCP tool's JSON Schema (input or output) into a Zod v4 object
 * schema. `callModel` derives the model-facing parameters from this Zod schema,
 * so the conversion must be faithful — a permissive passthrough would make the
 * model call the tool blind.
 *
 * Strategy: attempt a holistic `z.fromJSONSchema` conversion first (handles
 * `$ref`/`$defs`, `anyOf`, formats, nesting); on failure, fall back per the
 * chosen `mode`.
 */
export function convertMcpInputSchema(
  jsonSchema: Record<string, unknown>,
  mode: UnconvertibleSchemaMode = 'looseLeaf',
): $ZodObject {
  try {
    const converted = z.fromJSONSchema(jsonSchema);
    if (isZodObject(converted)) {
      return converted;
    }
    // MCP guarantees object-typed tool schemas; if a server sends something
    // else, degrade to a per-property object rather than handing callModel a
    // non-object schema it cannot use.
    return buildObjectFromProperties(jsonSchema, mode);
  } catch (err) {
    if (mode === 'throw') {
      throw new MCPError('Cannot convert MCP JSON Schema to Zod', {
        cause: err,
      });
    }
    return buildObjectFromProperties(jsonSchema, mode);
  }
}

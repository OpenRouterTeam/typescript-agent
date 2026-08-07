/**
 * Typeguards over the raw JSON-Schema-shaped values that arrive from an MCP
 * server. MCP tool input/output schemas are untrusted `unknown` data, so we
 * narrow them with runtime checks rather than `as` casts.
 */

/** A non-null, non-array object — the shape every JSON Schema node takes. */
export function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON Schema whose top-level `type` is `"object"`. */
export function isObjectJsonSchema(value: unknown): value is Record<string, unknown> & {
  type: 'object';
} {
  return isJsonSchemaObject(value) && value['type'] === 'object';
}

/** The `properties` map of an object schema, when present and well-formed. */
export function getSchemaProperties(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const { properties } = schema;
  return isJsonSchemaObject(properties) ? properties : undefined;
}

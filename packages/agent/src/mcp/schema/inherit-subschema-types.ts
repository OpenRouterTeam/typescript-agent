import { getSchemaProperties, isJsonSchemaObject } from './json-schema-guards.js';

/** What an enclosing schema already says about the instance a subschema applies to. */
interface Enclosing {
  type: string | undefined;
  properties: Record<string, unknown>;
}

const COMBINATORS = [
  'allOf',
  'anyOf',
  'oneOf',
] as const;

/**
 * Returns a copy of `schema` in which a branch of `allOf`/`anyOf`/`oneOf`
 * states the `type` its enclosing schema already requires, and a branch that
 * requires a key it does not describe carries the enclosing description of it.
 *
 * JSON Schema lets a branch leave both out, because the enclosing schema
 * applies to the same value: `{ type: 'object', oneOf: [{ required: ['id'] }] }`
 * is complete. `z.fromJSONSchema` converts each branch on its own, though, and
 * turns one with no `type` into `z.any()`, so a `oneOf` of such branches matches
 * every branch and rejects every value, and an `anyOf` of them accepts every
 * value. Restating what the enclosing schema requires changes no valid value's
 * validity, and gives Zod the constraint.
 *
 * The input is not modified: the server's schema is also what the model is sent.
 */
export function inheritSubschemaTypes(schema: Record<string, unknown>): Record<string, unknown> {
  return inherit(schema, undefined);
}

function inherit(
  schema: Record<string, unknown>,
  enclosing: Enclosing | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...schema,
  };
  // A `$ref` branch gets its type from the definition it points at.
  if (schema['type'] === undefined && enclosing?.type !== undefined && !('$ref' in schema)) {
    result['type'] = enclosing.type;
  }
  const ownProperties = getSchemaProperties(schema) ?? {};
  const here: Enclosing = {
    type: typeof result['type'] === 'string' ? result['type'] : undefined,
    properties: {
      ...enclosing?.properties,
      ...ownProperties,
    },
  };

  const properties = inheritProperties(schema, ownProperties, enclosing);
  if (properties !== undefined) {
    result['properties'] = properties;
  }
  for (const keyword of COMBINATORS) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      result[keyword] = branches.map((branch: unknown) =>
        isJsonSchemaObject(branch) ? inherit(branch, here) : branch,
      );
    }
  }
  for (const keyword of [
    'items',
    'additionalProperties',
  ]) {
    const sub = schema[keyword];
    if (isJsonSchemaObject(sub)) {
      result[keyword] = inherit(sub, undefined);
    }
  }
  for (const keyword of [
    '$defs',
    'definitions',
  ]) {
    const defs = schema[keyword];
    if (isJsonSchemaObject(defs)) {
      result[keyword] = mapSchemas(defs, (def) => inherit(def, undefined));
    }
  }
  return result;
}

/** The schema's `properties`, each inheriting from the enclosing description of the same key. */
function inheritProperties(
  schema: Record<string, unknown>,
  ownProperties: Record<string, unknown>,
  enclosing: Enclosing | undefined,
): Record<string, unknown> | undefined {
  const described = mapSchemas(ownProperties, (property, key) =>
    inherit(property, enclosingOf(enclosing?.properties[key])),
  );
  const borrowed = borrowRequiredProperties(schema, ownProperties, enclosing);
  if (Object.keys(described).length === 0 && Object.keys(borrowed).length === 0) {
    return undefined;
  }
  return {
    ...described,
    ...borrowed,
  };
}

/**
 * Zod does not enforce a `required` key the object does not describe. A branch
 * such as `{ required: ['query'] }` relies on the enclosing `properties.query`,
 * so that description is copied in. Skipped when the branch constrains its
 * other keys, where adding one would change what it accepts.
 */
function borrowRequiredProperties(
  schema: Record<string, unknown>,
  ownProperties: Record<string, unknown>,
  enclosing: Enclosing | undefined,
): Record<string, unknown> {
  const { required } = schema;
  if (
    enclosing === undefined ||
    !Array.isArray(required) ||
    '$ref' in schema ||
    'additionalProperties' in schema ||
    'patternProperties' in schema
  ) {
    return {};
  }
  const borrowed: Record<string, unknown> = {};
  for (const key of required) {
    if (typeof key !== 'string' || Object.hasOwn(ownProperties, key)) {
      continue;
    }
    const description = Object.hasOwn(enclosing.properties, key)
      ? enclosing.properties[key]
      : undefined;
    if (isJsonSchemaObject(description)) {
      borrowed[key] = inherit(description, undefined);
    }
  }
  return borrowed;
}

function enclosingOf(schema: unknown): Enclosing | undefined {
  if (!isJsonSchemaObject(schema)) {
    return undefined;
  }
  return {
    type: typeof schema['type'] === 'string' ? schema['type'] : undefined,
    properties: getSchemaProperties(schema) ?? {},
  };
}

/** Maps the object-valued entries; boolean schemas and anything else pass through. */
function mapSchemas(
  schemas: Record<string, unknown>,
  map: (schema: Record<string, unknown>, key: string) => Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schemas).map(([key, value]) => [
      key,
      isJsonSchemaObject(value) ? map(value, key) : value,
    ]),
  );
}

import { isJsonSchemaObject } from './schema/json-schema-guards.js';
import type { McpToolDef } from './tool-wrapper.js';

/**
 * Structural equality over JSON-shaped values. Object key order is ignored;
 * array order is not.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  if (!isJsonSchemaObject(a) || !isJsonSchemaObject(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  );
}

/**
 * Whether two tool listings describe the same tools, in the same order.
 *
 * Compares the definitions whole rather than field by field, so a field added
 * to {@link McpToolDef} later is covered without anyone remembering to list it
 * here. Anything it cannot prove equal counts as different, which only costs a
 * rebuild.
 */
export function sameToolDefs(a: readonly McpToolDef[], b: readonly McpToolDef[]): boolean {
  return jsonEqual(a, b);
}

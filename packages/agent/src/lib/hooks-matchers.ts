import type { ToolMatcher } from './hooks-types.js';

/**
 * Evaluate a ToolMatcher against a tool name.
 *
 * - `undefined` -> wildcard, matches all tools
 * - `string` -> exact match
 * - `RegExp` -> `.test(toolName)`
 * - `function` -> arbitrary predicate
 */
export function matchesTool(matcher: ToolMatcher | undefined, toolName: string): boolean {
  if (matcher === undefined) {
    return true;
  }
  if (typeof matcher === 'string') {
    return matcher === toolName;
  }
  if (matcher instanceof RegExp) {
    return matcher.test(toolName);
  }
  return matcher(toolName);
}

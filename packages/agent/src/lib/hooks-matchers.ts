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
    // RegExps with the /g or /y flag advance `lastIndex` on every `.test()`,
    // so successive emits with the same tool name alternate true/false.
    // Reset so the matcher behaves statelessly regardless of flag.
    matcher.lastIndex = 0;
    return matcher.test(toolName);
  }
  return matcher(toolName);
}

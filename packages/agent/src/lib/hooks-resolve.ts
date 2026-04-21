import { getInternalRegistrar, HooksManager } from './hooks-manager.js';
import { BUILT_IN_HOOK_NAMES } from './hooks-schemas.js';
import type { HookEntry, InlineHookConfig } from './hooks-types.js';

/**
 * Normalize a hooks option into a HooksManager instance.
 *
 * - `undefined` -> `undefined` (no hooks)
 * - `HooksManager` -> passthrough
 * - Plain object (InlineHookConfig) -> construct HooksManager, register all entries
 *
 * The inline config surface is typed to only accept built-in hook names, but
 * a generic config coerced through `as` can smuggle typos past the compiler
 * (e.g. `PretoolUse` vs `PreToolUse`) which would silently never fire. We log
 * a warning for any non-built-in key and skip registration for it. Custom
 * hooks must be registered through a `HooksManager` instance via `on()`.
 */
export function resolveHooks(
  hooks: InlineHookConfig | HooksManager | undefined,
): HooksManager | undefined {
  if (!hooks) {
    return undefined;
  }

  if (hooks instanceof HooksManager) {
    return hooks;
  }

  // Inline config -> HooksManager. We register through the internal registrar
  // so we don't have to constrain `resolveHooks` to the typed `on()` surface
  // and so user code can't reach this path.
  const manager = new HooksManager();
  const register = getInternalRegistrar(manager);
  for (const [hookName, entries] of Object.entries(hooks)) {
    if (!entries || !Array.isArray(entries)) {
      continue;
    }
    if (!BUILT_IN_HOOK_NAMES.has(hookName)) {
      console.warn(
        `[resolveHooks] Ignoring inline hook entry for unknown hook name "${hookName}". Inline config only supports built-in hooks; register custom hooks via a HooksManager instance.`,
      );
      continue;
    }
    for (const entry of entries) {
      register(hookName, entry as HookEntry<unknown, unknown>);
    }
  }
  return manager;
}

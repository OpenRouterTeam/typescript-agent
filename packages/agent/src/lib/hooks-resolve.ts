import { getInternalRegistrar, HooksManager } from './hooks-manager.js';
import type { HookEntry, InlineHookConfig } from './hooks-types.js';

/**
 * Normalize a hooks option into a HooksManager instance.
 *
 * - `undefined` -> `undefined` (no hooks)
 * - `HooksManager` -> passthrough
 * - Plain object (InlineHookConfig) -> construct HooksManager, register all entries
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
    for (const entry of entries) {
      register(hookName, entry as HookEntry<unknown, unknown>);
    }
  }
  return manager;
}

import type { infer as zodInfer } from 'zod/v4/core';
import type {
  BuiltInHookDefinitions,
  EmitResult,
  HookContext,
  HookEntry,
  HookHandler,
  HookRegistry,
  HooksManagerOptions,
  ToolMatcher,
} from './hooks-types.js';
import { BUILT_IN_HOOK_NAMES } from './hooks-schemas.js';
import { executeHandlerChain } from './hooks-emit.js';

//#region Types

type AllHooks<Custom extends HookRegistry> = BuiltInHookDefinitions & {
  [K in keyof Custom]: {
    payload: zodInfer<Custom[K]['payload']>;
    result: zodInfer<Custom[K]['result']>;
  };
};

type PayloadOf<H extends AllHooks<HookRegistry>, K extends keyof H> = H[K]['payload'];
type ResultOf<H extends AllHooks<HookRegistry>, K extends keyof H> = H[K]['result'];

interface EntryRegistration<P, R> {
  readonly handler: HookHandler<P, R>;
  readonly matcher?: ToolMatcher;
  readonly filter?: (payload: P) => boolean;
}

//#endregion

/**
 * Typed, extensible hook system for agent lifecycle events.
 *
 * Supports both built-in hooks (PreToolUse, PostToolUse, etc.) and
 * user-defined custom hooks with full type safety.
 */
export class HooksManager<Custom extends HookRegistry = Record<string, never>> {
  private readonly entries = new Map<string, HookEntry<unknown, unknown>[]>();
  private readonly pendingAsync: Promise<void>[] = [];
  private readonly throwOnHandlerError: boolean;
  private sessionId = '';

  constructor(customHooks?: Custom, options?: HooksManagerOptions) {
    this.throwOnHandlerError = options?.throwOnHandlerError ?? false;

    // Validate no collisions between custom and built-in hook names
    if (customHooks) {
      for (const name of Object.keys(customHooks)) {
        if (BUILT_IN_HOOK_NAMES.has(name)) {
          throw new Error(
            `Custom hook name "${name}" collides with a built-in hook. Choose a different name.`,
          );
        }
      }
    }
  }

  /**
   * Set the session ID used in HookContext for all handler invocations.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Register a handler for a hook. Returns an unsubscribe function.
   */
  on<K extends keyof AllHooks<Custom> & string>(
    hookName: K,
    entry: EntryRegistration<PayloadOf<AllHooks<Custom>, K>, ResultOf<AllHooks<Custom>, K>>,
  ): () => void {
    return this.registerEntry(hookName, entry as HookEntry<unknown, unknown>);
  }

  /**
   * Internal: register an untyped entry. Used by resolveHooks for inline config normalization.
   * @internal
   */
  registerEntry(hookName: string, entry: HookEntry<unknown, unknown>): () => void {
    const list = this.entries.get(hookName) ?? [];
    list.push(entry);
    this.entries.set(hookName, list);

    return () => {
      const current = this.entries.get(hookName);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx !== -1) {
        current.splice(idx, 1);
      }
    };
  }

  /**
   * Remove a specific handler function from a hook.
   * Returns true if found and removed, false otherwise.
   */
  off<K extends keyof AllHooks<Custom> & string>(
    hookName: K,
    handler: HookHandler<PayloadOf<AllHooks<Custom>, K>, ResultOf<AllHooks<Custom>, K>>,
  ): boolean {
    const list = this.entries.get(hookName);
    if (!list) return false;

    const idx = list.findIndex((e) => e.handler === handler);
    if (idx === -1) return false;

    list.splice(idx, 1);
    return true;
  }

  /**
   * Remove all handlers for a specific hook, or all handlers if no name given.
   */
  removeAll<K extends keyof AllHooks<Custom> & string>(hookName?: K): void {
    if (hookName) {
      this.entries.delete(hookName);
    } else {
      this.entries.clear();
    }
  }

  /**
   * Validate the payload, invoke matching handlers, and return results.
   */
  async emit<K extends keyof AllHooks<Custom> & string>(
    hookName: K,
    payload: PayloadOf<AllHooks<Custom>, K>,
    emitContext?: { toolName?: string },
  ): Promise<EmitResult<ResultOf<AllHooks<Custom>, K>, PayloadOf<AllHooks<Custom>, K>>> {
    const list = this.entries.get(hookName) ?? [];

    const context: HookContext = {
      signal: new AbortController().signal,
      hookName,
      sessionId: this.sessionId,
    };

    const result = await executeHandlerChain(
      list as ReadonlyArray<HookEntry<PayloadOf<AllHooks<Custom>, K>, ResultOf<AllHooks<Custom>, K>>>,
      payload,
      context,
      {
        hookName,
        throwOnHandlerError: this.throwOnHandlerError,
        toolName: emitContext?.toolName,
      },
    );

    // Track pending async work for drain()
    this.pendingAsync.push(...result.pending);

    return result;
  }

  /**
   * Await all in-flight async handlers. Used for graceful shutdown.
   */
  async drain(): Promise<void> {
    const pending = this.pendingAsync.splice(0);
    await Promise.allSettled(pending);
  }

  /**
   * Check if any handlers are registered for a given hook.
   */
  hasHandlers(hookName: string): boolean {
    const list = this.entries.get(hookName);
    return list !== undefined && list.length > 0;
  }
}

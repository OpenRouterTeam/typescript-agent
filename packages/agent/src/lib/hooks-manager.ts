import type { $ZodType, infer as zodInfer } from 'zod/v4/core';
import { safeParse } from 'zod/v4/core';
import { executeHandlerChain } from './hooks-emit.js';
import { BUILT_IN_HOOK_NAMES, BUILT_IN_HOOKS, VOID_RESULT_HOOKS } from './hooks-schemas.js';
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
 * Module-private key used by `resolveHooks` to call the internal
 * untyped-registration path without exposing it as a public method on the
 * class. See {@link getInternalRegistrar} below.
 */
const INTERNAL_REGISTRAR_KEY: unique symbol = Symbol('HooksManager.internalRegistrar');

type InternalRegistrar = (hookName: string, entry: HookEntry<unknown, unknown>) => () => void;

/**
 * Typed, extensible hook system for agent lifecycle events.
 *
 * Supports both built-in hooks (PreToolUse, PostToolUse, etc.) and
 * user-defined custom hooks with full type safety.
 */
export class HooksManager<Custom extends HookRegistry = Record<string, never>> {
  private readonly entries = new Map<string, HookEntry<unknown, unknown>[]>();
  private readonly pendingAsync = new Set<Promise<void>>();
  private readonly customHooks: HookRegistry;
  private readonly inflightControllers = new Set<AbortController>();
  private readonly throwOnHandlerError: boolean;
  private sessionId = '';

  constructor(customHooks?: Custom, options?: HooksManagerOptions) {
    this.throwOnHandlerError = options?.throwOnHandlerError ?? false;

    // Validate no collisions between custom and built-in hook names.
    if (customHooks) {
      for (const name of Object.keys(customHooks)) {
        if (BUILT_IN_HOOK_NAMES.has(name)) {
          throw new Error(
            `Custom hook name "${name}" collides with a built-in hook. Choose a different name.`,
          );
        }
      }
      this.customHooks = {
        ...customHooks,
      };
    } else {
      this.customHooks = {};
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
    return this._register(hookName, entry as HookEntry<unknown, unknown>);
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
    if (!list) {
      return false;
    }

    const idx = list.findIndex((e) => e.handler === handler);
    if (idx === -1) {
      return false;
    }

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
   * Validate the payload (and each handler's result) against the registered
   * Zod schemas, invoke matching handlers, and return results.
   *
   * Payload validation failure is treated according to `throwOnHandlerError`:
   * strict mode re-throws, default mode logs a warning and returns an empty
   * result without invoking any handlers.
   */
  async emit<K extends keyof AllHooks<Custom> & string>(
    hookName: K,
    payload: PayloadOf<AllHooks<Custom>, K>,
    emitContext?: {
      toolName?: string;
    },
  ): Promise<EmitResult<ResultOf<AllHooks<Custom>, K>, PayloadOf<AllHooks<Custom>, K>>> {
    const list = this.entries.get(hookName) ?? [];

    const definition = this._definitionFor(hookName);
    if (definition) {
      const parsed = safeParse(definition.payload, payload);
      if (!parsed.success) {
        const err = new Error(
          `[HooksManager] Invalid payload for hook "${hookName}": ${parsed.error.message}`,
        );
        if (this.throwOnHandlerError) {
          throw err;
        }
        console.warn(err.message);
        return {
          results: [],
          pending: [],
          finalPayload: payload,
          blocked: false,
        };
      }
    }

    const controller = new AbortController();
    this.inflightControllers.add(controller);

    const context: HookContext = {
      signal: controller.signal,
      hookName,
      sessionId: this.sessionId,
    };

    try {
      const resultSchema =
        definition && !VOID_RESULT_HOOKS.has(hookName) ? definition.result : undefined;

      const result = await executeHandlerChain(
        list as ReadonlyArray<
          HookEntry<PayloadOf<AllHooks<Custom>, K>, ResultOf<AllHooks<Custom>, K>>
        >,
        payload,
        context,
        {
          hookName,
          throwOnHandlerError: this.throwOnHandlerError,
          toolName: emitContext?.toolName,
          resultSchema,
        },
      );

      // Track pending async work for drain(); each promise self-removes once
      // it settles so the set can't grow unbounded across many emits.
      for (const p of result.pending) {
        this.pendingAsync.add(p);
        p.finally(() => {
          this.pendingAsync.delete(p);
        });
      }

      return result;
    } finally {
      this.inflightControllers.delete(controller);
    }
  }

  /**
   * Await all in-flight async handler work. Used for graceful shutdown.
   */
  async drain(): Promise<void> {
    while (this.pendingAsync.size > 0) {
      const snapshot = Array.from(this.pendingAsync);
      await Promise.allSettled(snapshot);
    }
  }

  /**
   * Abort every in-flight `emit()` by firing their context `signal`s. Handlers
   * that kick off async work should observe `context.signal` to honor this.
   *
   * Does not remove pending async work from `pendingAsync` — callers that want
   * to wait for handlers to wind down should still call `drain()` afterward.
   */
  abortInflight(reason?: unknown): void {
    for (const controller of this.inflightControllers) {
      controller.abort(reason);
    }
  }

  /**
   * Check if any handlers are registered for a given hook.
   */
  hasHandlers(hookName: string): boolean {
    const list = this.entries.get(hookName);
    return list !== undefined && list.length > 0;
  }

  /**
   * Internal registration path used by `resolveHooks` to translate an
   * InlineHookConfig object into this manager. User code should use `on()`.
   */
  [INTERNAL_REGISTRAR_KEY](hookName: string, entry: HookEntry<unknown, unknown>): () => void {
    return this._register(hookName, entry);
  }

  private _register(hookName: string, entry: HookEntry<unknown, unknown>): () => void {
    const list = this.entries.get(hookName) ?? [];
    list.push(entry);
    this.entries.set(hookName, list);

    return () => {
      const current = this.entries.get(hookName);
      if (!current) {
        return;
      }
      const idx = current.indexOf(entry);
      if (idx !== -1) {
        current.splice(idx, 1);
      }
    };
  }

  private _definitionFor(hookName: string):
    | {
        payload: $ZodType;
        result: $ZodType;
      }
    | undefined {
    const builtIn = BUILT_IN_HOOKS[hookName];
    if (builtIn) {
      return builtIn;
    }
    const custom = this.customHooks[hookName];
    if (custom) {
      return custom;
    }
    return undefined;
  }
}

/**
 * Internal: return the private registrar of a HooksManager instance. This
 * lets `resolveHooks` register arbitrary hook names (including unknown ones
 * from an inline config) without exposing a public bypass of the typed `on()`.
 *
 * NOT PART OF THE PUBLIC API.
 */
export function getInternalRegistrar(manager: HooksManager): InternalRegistrar {
  return manager[INTERNAL_REGISTRAR_KEY].bind(manager);
}

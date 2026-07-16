import type { $ZodType, infer as zodInfer, input as zodInput } from 'zod/v4/core';
import { safeParse } from 'zod/v4/core';
import { executeHandlerChain } from './hooks-emit.js';
import { BUILT_IN_HOOK_NAMES, BUILT_IN_HOOKS } from './hooks-schemas.js';
import type {
  BuiltInHookDefinitions,
  EmitResult,
  HookDefinition,
  HookEntry,
  HookHandler,
  HookRegistry,
  HooksManagerOptions,
  LifecycleHookContext,
} from './hooks-types.js';

//#region Types

/**
 * Type-level registry of every hook this manager knows: built-ins plus the
 * instance's custom hooks. Each entry carries:
 *
 * - `payload`: the schema OUTPUT -- what handlers receive and `finalPayload`
 *   holds (post-validation, transforms/defaults applied)
 * - `payloadIn`: the schema INPUT -- what `emit()` accepts (differs from
 *   `payload` for schemas with .transform()/.default()/.coerce). Built-in
 *   schemas have no transforms, so input == output there.
 * - `result`: the validated handler result
 */
type AllHooks<Custom extends HookRegistry> = {
  [K in keyof BuiltInHookDefinitions]: {
    payload: BuiltInHookDefinitions[K]['payload'];
    payloadIn: BuiltInHookDefinitions[K]['payload'];
    result: BuiltInHookDefinitions[K]['result'];
  };
} & {
  [K in keyof Custom]: {
    payload: zodInfer<Custom[K]['payload']>;
    payloadIn: zodInput<Custom[K]['payload']>;
    result: zodInfer<Custom[K]['result']>;
  };
};

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

    // Validate custom hook names: no empty names, no collisions with built-ins.
    if (customHooks) {
      for (const name of Object.keys(customHooks)) {
        if (name === '') {
          throw new Error('Custom hook names must be non-empty strings.');
        }
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
   * Set the session ID exposed as `context.sessionId` to all handler
   * invocations. The single source of session identity for hooks -- payloads
   * deliberately do not carry it.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Register a handler for a hook. Returns an unsubscribe function.
   */
  on<K extends keyof AllHooks<Custom> & string>(
    hookName: K,
    entry: HookEntry<AllHooks<Custom>[K]['payload'], AllHooks<Custom>[K]['result']>,
  ): () => void {
    return this._register(hookName, entry as HookEntry<unknown, unknown>);
  }

  /**
   * Remove a specific handler function from a hook.
   * Returns true if found and removed, false otherwise.
   */
  off<K extends keyof AllHooks<Custom> & string>(
    hookName: K,
    handler: HookHandler<AllHooks<Custom>[K]['payload'], AllHooks<Custom>[K]['result']>,
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
    if (list.length === 0) {
      this.entries.delete(hookName);
    }
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
    payload: AllHooks<Custom>[K]['payloadIn'],
    emitContext?: {
      toolName?: string;
    },
  ): Promise<EmitResult<AllHooks<Custom>[K]['result'], AllHooks<Custom>[K]['payload']>> {
    // Snapshot the entries list so mutations (on()/off()/unsubscribe) triggered
    // by a handler during the chain can't shift indices mid-iteration and
    // silently skip the next handler, or splice in new handlers that were
    // registered after this emit began.
    const list = (this.entries.get(hookName) ?? []).slice();

    // Validate the payload and, on success, feed the PARSED value into the
    // chain. For schemas with .transform() / .default() / .coerce (or that
    // strip unknown keys) the parsed output differs from the raw input: emit
    // accepts the schema INPUT type (`payloadIn`) while handlers and
    // finalPayload carry the schema OUTPUT (`payload`) -- so handlers must
    // receive `parsed.data`, not the raw value, or the runtime shape silently
    // diverges from the static types.
    let chainPayload = payload as unknown as AllHooks<Custom>[K]['payload'];
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
          finalPayload: chainPayload,
          blocked: false,
          mutated: false,
        };
      }
      chainPayload = parsed.data as AllHooks<Custom>[K]['payload'];
    }

    const controller = new AbortController();
    this.inflightControllers.add(controller);

    const context: LifecycleHookContext = {
      signal: controller.signal,
      hookName,
      sessionId: this.sessionId,
    };

    let hasDetachedWork = false;
    try {
      // Result validation is skipped for hooks whose result schema is void --
      // decided by SCHEMA SHAPE, not by a hard-coded name list, so custom
      // hooks registered with `result: z.void()` behave exactly like the
      // built-in void hooks (handlers may return arbitrary values that are
      // collected as opaque results without complaint).
      const resultSchema =
        definition && !isVoidSchema(definition.result) ? definition.result : undefined;

      const result = await executeHandlerChain(
        list as ReadonlyArray<
          HookEntry<AllHooks<Custom>[K]['payload'], AllHooks<Custom>[K]['result']>
        >,
        chainPayload,
        context,
        {
          hookName,
          throwOnHandlerError: this.throwOnHandlerError,
          toolName: emitContext?.toolName,
          resultSchema,
          // When a handler's fire-and-forget work exceeds its asyncTimeout,
          // abort this emit's signal so handlers observing context.signal can
          // cancel the stale work cooperatively.
          onAsyncTimeout: () => {
            controller.abort(new Error('Hook async work timed out'));
          },
        },
      );

      // Track pending async work for drain(); each promise self-removes once
      // it settles so the set can't grow unbounded across many emits.
      hasDetachedWork = result.pending.length > 0;
      if (hasDetachedWork) {
        let remaining = result.pending.length;
        for (const p of result.pending) {
          this.pendingAsync.add(p);
          p.finally(() => {
            this.pendingAsync.delete(p);
            // The emit's controller must stay registered until the detached
            // work settles so abortInflight() can reach fire-and-forget
            // handlers that outlive the emit call itself.
            remaining--;
            if (remaining === 0) {
              this.inflightControllers.delete(controller);
            }
          });
        }
      }

      return result;
    } finally {
      // With detached work in flight the controller lives until that work
      // settles (see above); otherwise it can be dropped now.
      if (!hasDetachedWork) {
        this.inflightControllers.delete(controller);
      }
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
    const builtIn = (BUILT_IN_HOOKS as Record<string, HookDefinition | undefined>)[hookName];
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

/**
 * Detect a `z.void()` schema (zod v4 core). Result validation is skipped for
 * void-result hooks so side-effect-only handlers can return arbitrary values
 * without tripping validation -- for built-ins and custom hooks alike.
 *
 * Implementation note: `schema._zod.def.type` is zod v4's designated
 * introspection surface for library authors (every `$ZodType` carries a
 * `_zod: $ZodTypeInternals` with a stable `def.type` discriminator). A string
 * check is deliberately preferred over `instanceof $ZodVoid`, which breaks
 * across duplicated zod module instances (dual-package hazard) and mixed
 * zod/v4 vs zod/v4-mini usage. Behavior is pinned by tests in
 * hooks-contract-fixes.test.ts ("void schema detection") so a zod upgrade
 * that restructures the internals fails loudly instead of silently
 * re-enabling result validation on void hooks.
 *
 * Exported for the pinning tests only; NOT re-exported from the package
 * index and NOT part of the public API.
 */
export function isVoidSchema(schema: $ZodType): boolean {
  const def = (
    schema as {
      _zod?: {
        def?: {
          type?: string;
        };
      };
    }
  )._zod?.def;
  return def?.type === 'void';
}

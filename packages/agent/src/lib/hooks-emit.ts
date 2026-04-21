import type { $ZodType } from 'zod/v4/core';
import { safeParse } from 'zod/v4/core';
import { matchesTool } from './hooks-matchers.js';
import type { AsyncOutput, EmitResult, HookEntry, LifecycleHookContext } from './hooks-types.js';
import {
  BLOCK_FIELDS,
  BLOCK_HOOKS,
  DEFAULT_ASYNC_TIMEOUT,
  isAsyncOutput,
  MUTATION_FIELD_MAP,
} from './hooks-types.js';

export interface ExecuteChainOptions {
  readonly hookName: string;
  readonly throwOnHandlerError: boolean;
  readonly toolName?: string | undefined;
  /**
   * Optional Zod schema to validate each handler's result BEFORE the chain
   * applies mutation piping or short-circuit logic. Validation errors are
   * handled the same way as handler throws: either re-thrown (strict mode) or
   * logged as a warning (default).
   *
   * Void-typed hooks typically pass `undefined` here; results in that case are
   * not validated.
   */
  readonly resultSchema?: $ZodType | undefined;
}

/**
 * Returns true for non-null, non-array plain objects -- values where
 * object-spread cloning is safe. Custom hooks can register payload schemas
 * like `z.number()`, `z.string()`, or `z.array(...)`; spreading a primitive
 * silently produces `{}` and spreading an array reindexes it into an object,
 * which would hand handlers a mangled value. This mirrors the invariant that
 * `applyMutations` relies on when deciding whether mutation piping can run.
 */
function isPlainMutableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Execute a chain of hook handlers sequentially.
 *
 * Supports:
 * - ToolMatcher and filter-based skipping (matcher fails closed: a handler with
 *   a matcher and no `options.toolName` is skipped)
 * - Sync results validated against `options.resultSchema` and collected into `results`
 * - Async fire-and-forget via a returned {@link AsyncOutput} -- the handler's
 *   `work` promise is pushed to `pending` without being awaited; the manager is
 *   responsible for draining/timing out that work
 * - Per-hook mutation piping (driven by {@link MUTATION_FIELD_MAP})
 * - Short-circuit on block/reject fields (non-empty string or `true`)
 */
export async function executeHandlerChain<P, R>(
  entries: ReadonlyArray<HookEntry<P, R>>,
  initialPayload: P,
  context: LifecycleHookContext,
  options: ExecuteChainOptions,
): Promise<EmitResult<R, P>> {
  const results: R[] = [];
  const pending: Promise<void>[] = [];
  // Only clone when the payload is a plain mutable object. Spreading a
  // primitive (e.g. a custom hook's `z.number()` payload) would silently
  // produce `{}`; spreading an array reindexes it into an object. For those
  // cases we pass the value through untouched so handlers see the original
  // typed-`P` value. For plain objects we still clone so the chain can apply
  // mutation piping without mutating the caller's payload in place.
  let currentPayload: P = isPlainMutableObject(initialPayload)
    ? ({
        ...initialPayload,
      } as P)
    : initialPayload;
  let blocked = false;

  const blockField = BLOCK_FIELDS[options.hookName];
  const canBlock = BLOCK_HOOKS.has(options.hookName);
  const mutationMap = MUTATION_FIELD_MAP[options.hookName];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }

    // Matcher check for tool-scoped hooks. Matchers fail closed: if a matcher
    // is registered and no toolName is available for this emit, we skip the
    // handler rather than invoking it globally.
    if (entry.matcher !== undefined) {
      if (options.toolName === undefined) {
        continue;
      }
      if (!matchesTool(entry.matcher, options.toolName)) {
        continue;
      }
    }

    // Filter check
    if (entry.filter && !entry.filter(currentPayload)) {
      continue;
    }

    try {
      const returnValue = await entry.handler(currentPayload, context);

      // Async fire-and-forget: the handler has returned a signal describing
      // detached work. Track the (optional) work promise for drain/timeout.
      if (isAsyncOutput(returnValue)) {
        const asyncOutput: AsyncOutput = returnValue;
        const trackedWork = trackAsyncWork(asyncOutput, options.hookName);
        if (trackedWork !== undefined) {
          pending.push(trackedWork);
        }
        continue;
      }

      // Void / undefined / null -- side-effect only, continue
      if (returnValue === undefined || returnValue === null) {
        continue;
      }

      // Validate the result against the schema if one is supplied. A failure
      // here is treated like any other handler error: propagated in strict
      // mode, logged otherwise. On success, use the parsed output (which may
      // differ from the input for schemas with .transform() / .default() /
      // .catch() / .coerce) so downstream callers see transformed values.
      let result: R;
      if (options.resultSchema) {
        const validation = safeParse(options.resultSchema, returnValue);
        if (!validation.success) {
          const err = new Error(
            `[HooksManager] Handler ${i} for hook "${options.hookName}" returned an invalid result: ${validation.error.message}`,
          );
          if (options.throwOnHandlerError) {
            throw err;
          }
          console.warn(err.message);
          continue;
        }
        result = validation.data as R;
      } else {
        result = returnValue as R;
      }
      results.push(result);

      // Apply mutation piping -- only hooks listed in MUTATION_FIELD_MAP participate.
      if (mutationMap) {
        currentPayload = applyMutations(currentPayload, result, mutationMap);
      }

      // Short-circuit on block
      if (canBlock && blockField && isBlockTriggered(result, blockField)) {
        blocked = true;
        break;
      }
    } catch (error) {
      if (options.throwOnHandlerError) {
        throw error;
      }
      console.warn(`[HooksManager] Handler ${i} for hook "${options.hookName}" threw:`, error);
    }
  }

  return {
    results,
    pending,
    finalPayload: currentPayload,
    blocked,
  };
}

/**
 * Given an {@link AsyncOutput} signal, return a Promise<void> that resolves
 * when the handler's detached `work` settles OR the timeout fires -- whichever
 * is first. Returns `undefined` if there is no work to track.
 *
 * Rejections of the detached `work` promise are logged as warnings. Note:
 * `throwOnHandlerError` governs synchronous handler failures only -- detached
 * fire-and-forget work never re-throws here, it just surfaces via the warning.
 */
function trackAsyncWork(output: AsyncOutput, hookName: string): Promise<void> | undefined {
  if (output.work === undefined) {
    return undefined;
  }
  const timeout = output.asyncTimeout ?? DEFAULT_ASYNC_TIMEOUT;

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve();
    };

    const timeoutId = setTimeout(finish, timeout);

    output.work?.then(finish, (error: unknown) => {
      console.warn(`[HooksManager] Async work for hook "${hookName}" rejected:`, error);
      finish();
    });
  });
}

/**
 * Apply mutation fields from a result onto the current payload.
 */
function applyMutations<P, R>(payload: P, result: R, mutationMap: Record<string, string>): P {
  if (typeof result !== 'object' || result === null) {
    return payload;
  }

  let mutated = payload;
  for (const [resultField, payloadField] of Object.entries(mutationMap)) {
    if (resultField in result) {
      const value = (result as Record<string, unknown>)[resultField];
      if (value !== undefined) {
        mutated = {
          ...mutated,
          [payloadField]: value,
        };
      }
    }
  }
  return mutated;
}

/**
 * Check if a result triggers a short-circuit block.
 *
 * A block fires when the field is `=== true` or a non-empty string. Empty
 * strings are treated as "no block reason supplied" -- they do NOT trigger a
 * short-circuit, which keeps emit consistent with callers that look up the
 * first block reason with a truthy check.
 */
function isBlockTriggered<R>(result: R, blockField: string): boolean {
  if (typeof result !== 'object' || result === null) {
    return false;
  }
  const value = (result as Record<string, unknown>)[blockField];
  if (value === true) {
    return true;
  }
  return typeof value === 'string' && value.length > 0;
}

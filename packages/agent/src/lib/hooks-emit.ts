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
  /**
   * Invoked when a handler's fire-and-forget `work` exceeds its
   * `asyncTimeout`. The manager uses this to abort the emit's signal so
   * handlers that observe `context.signal` can cancel the stale work.
   */
  readonly onAsyncTimeout?: ((hookName: string) => void) | undefined;
}

/**
 * Returns true only for plain objects (prototype of `Object.prototype` or
 * `null`) -- values where object-spread cloning is safe. Custom hooks can
 * register payload schemas like `z.number()`, `z.string()`, `z.array(...)`,
 * or `z.date()`; spreading a primitive silently produces `{}`, spreading an
 * array reindexes it into an object, and spreading a `Date`/`Map`/class
 * instance flattens it to a near-empty POJO. All of those would hand handlers
 * a mangled value, so only true plain objects are cloned; everything else
 * passes through untouched (and does not participate in mutation piping).
 */
function isPlainMutableObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
 * - Cooperative abort via `context.signal`: the chain checks
 *   `signal.aborted` between handlers and bails out when set so
 *   `abortInflight()` has a deterministic effect on the chain itself (not just
 *   on handlers that happen to consult the signal).
 *
 * Payload isolation: the initial payload is shallow-cloned before entering the
 * chain so mutation piping (via {@link MUTATION_FIELD_MAP}) doesn't mutate the
 * caller's payload at the top level. This is a top-level-only guarantee:
 * handlers that directly mutate a nested object (e.g.
 * `payload.toolInput.foo = 'bar'`) still reach the caller's original nested
 * reference. Handlers MUST return mutations via the documented result fields
 * (e.g. `mutatedInput`) rather than mutating nested payload fields in place.
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
  // mutation piping without mutating the caller's payload at the top level.
  // Nested fields are shared with the caller; see the function-level docstring
  // for the invariant handlers are expected to respect.
  let currentPayload: P = isPlainMutableObject(initialPayload)
    ? ({
        ...initialPayload,
      } as P)
    : initialPayload;
  let blocked = false;
  let mutated = false;

  const blockField = BLOCK_FIELDS[options.hookName];
  const canBlock = BLOCK_HOOKS.has(options.hookName);
  const mutationMap = MUTATION_FIELD_MAP[options.hookName];

  for (let i = 0; i < entries.length; i++) {
    // Cooperative abort: bail out of the chain when abortInflight() has fired.
    // Checked before each handler so synchronous chains stop promptly instead
    // of running to completion with only advisory notice to each handler.
    if (context.signal.aborted) {
      break;
    }

    const entry = entries[i];
    if (!entry) {
      continue;
    }

    // Matcher and filter checks run under the same error policy as handlers:
    // in non-strict mode a throwing user-supplied matcher function or filter
    // is logged and the entry skipped, instead of crashing the whole chain.
    const gate = evaluateEntryGate(entry, currentPayload, i, options);
    if (gate === 'skip') {
      continue;
    }

    try {
      const returnValue = await entry.handler(currentPayload, context);
      const outcome = classifyHandlerReturn<R>(returnValue, i, options);

      if (outcome.kind === 'async') {
        // Fire-and-forget: track the (optional) work promise for drain/timeout.
        if (outcome.trackedWork !== undefined) {
          pending.push(outcome.trackedWork);
        }
        continue;
      }
      if (outcome.kind === 'skip') {
        // Void return, or result-schema validation failed in non-strict mode.
        continue;
      }

      const result = outcome.result;
      results.push(result);

      // Apply mutation piping -- only hooks listed in MUTATION_FIELD_MAP participate.
      if (mutationMap) {
        const applied = applyMutations(currentPayload, result, mutationMap);
        if (applied !== currentPayload) {
          currentPayload = applied;
          mutated = true;
        }
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
    mutated,
  };
}

/**
 * Evaluate an entry's matcher and filter under the chain's error policy.
 *
 * Matchers fail closed: if a matcher is registered and no toolName is
 * available for this emit, the handler is skipped rather than invoked
 * globally. A throwing matcher function or filter is re-thrown in strict
 * mode, or logged and treated as a skip otherwise.
 */
function evaluateEntryGate<P, R>(
  entry: HookEntry<P, R>,
  payload: P,
  index: number,
  options: ExecuteChainOptions,
): 'run' | 'skip' {
  try {
    // Matcher first; the filter must not run when the matcher already
    // rejected the entry (filters can be effectful or expensive).
    const matcherPasses =
      entry.matcher === undefined ||
      (options.toolName !== undefined && matchesTool(entry.matcher, options.toolName));
    if (!matcherPasses) {
      return 'skip';
    }
    return !entry.filter || Boolean(entry.filter(payload)) ? 'run' : 'skip';
  } catch (error) {
    if (options.throwOnHandlerError) {
      throw error;
    }
    console.warn(
      `[HooksManager] Matcher/filter for handler ${index} of hook "${options.hookName}" threw:`,
      error,
    );
    return 'skip';
  }
}

type HandlerReturnOutcome<R> =
  | {
      kind: 'async';
      trackedWork: Promise<void> | undefined;
    }
  | {
      kind: 'skip';
    }
  | {
      kind: 'result';
      result: R;
    };

/**
 * Classify a handler's return value into one of three outcomes:
 *
 * - `async`: an {@link AsyncOutput} fire-and-forget signal (with the tracked
 *   work promise, if any)
 * - `skip`: void/undefined/null (side-effect only), or a result that failed
 *   schema validation in non-strict mode
 * - `result`: a validated result. When a result schema is supplied, the
 *   parsed output is returned -- which may differ from the input for schemas
 *   with .transform() / .default() / .catch() / .coerce -- so downstream
 *   callers see transformed values. Validation failure in strict mode throws.
 */
function classifyHandlerReturn<R>(
  returnValue: unknown,
  index: number,
  options: ExecuteChainOptions,
): HandlerReturnOutcome<R> {
  if (isAsyncOutput(returnValue)) {
    return {
      kind: 'async',
      trackedWork: trackAsyncWork(returnValue, options.hookName, options.onAsyncTimeout),
    };
  }
  if (returnValue === undefined || returnValue === null) {
    return {
      kind: 'skip',
    };
  }
  if (!options.resultSchema) {
    return {
      kind: 'result',
      result: returnValue as R,
    };
  }
  const validation = safeParse(options.resultSchema, returnValue);
  if (!validation.success) {
    const err = new Error(
      `[HooksManager] Handler ${index} for hook "${options.hookName}" returned an invalid result: ${validation.error.message}`,
    );
    if (options.throwOnHandlerError) {
      throw err;
    }
    console.warn(err.message);
    return {
      kind: 'skip',
    };
  }
  return {
    kind: 'result',
    result: validation.data as R,
  };
}

/**
 * Given an {@link AsyncOutput} signal, return a Promise<void> that resolves
 * when the handler's detached `work` settles OR the timeout fires -- whichever
 * is first. Returns `undefined` if there is no work to track.
 *
 * On timeout, `onTimeout` is invoked (the manager uses it to abort the emit's
 * signal) and the tracking promise resolves so `drain()` stops waiting. The
 * detached `work` itself cannot be forcibly cancelled -- handlers must observe
 * `context.signal` to actually stop; the timeout only bounds how long the
 * manager waits and signals cancellation cooperatively.
 *
 * Rejections of the detached `work` promise are logged as warnings. Note:
 * `throwOnHandlerError` governs synchronous handler failures only -- detached
 * fire-and-forget work never re-throws here, it just surfaces via the warning.
 */
function trackAsyncWork(
  output: AsyncOutput,
  hookName: string,
  onTimeout?: (hookName: string) => void,
): Promise<void> | undefined {
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

    const timeoutId = setTimeout(() => {
      if (!settled) {
        console.warn(
          `[HooksManager] Async work for hook "${hookName}" exceeded its ${timeout}ms timeout; abandoning wait.`,
        );
        onTimeout?.(hookName);
      }
      finish();
    }, timeout);
    // In Node.js, Timeout objects expose `.unref()` to remove the reference
    // the timer holds on the event loop. Without this, a leaked hook whose
    // `work` never settles keeps the process alive for the full
    // DEFAULT_ASYNC_TIMEOUT window after the main workload has finished.
    // Guarded for browsers / other environments that return a plain number
    // from setTimeout and don't expose the method.
    if (isUnrefable(timeoutId)) {
      timeoutId.unref();
    }

    output.work?.then(finish, (error: unknown) => {
      console.warn(`[HooksManager] Async work for hook "${hookName}" rejected:`, error);
      finish();
    });
  });
}

/**
 * Typeguard for the Node.js Timeout object that carries a `.unref()` method.
 * Browsers and other environments return a number from setTimeout, which has
 * no such method.
 */
function isUnrefable(handle: unknown): handle is {
  unref: () => void;
} {
  if (typeof handle !== 'object' || handle === null || !('unref' in handle)) {
    return false;
  }
  const candidate: {
    unref: unknown;
  } = handle;
  return typeof candidate.unref === 'function';
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

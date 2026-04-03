import type {
  AsyncOutput,
  EmitResult,
  HookContext,
  HookEntry,
} from './hooks-types.js';
import {
  BLOCK_FIELDS,
  BLOCK_HOOKS,
  DEFAULT_ASYNC_TIMEOUT,
  MUTATION_FIELD_MAP,
  isAsyncOutput,
} from './hooks-types.js';
import { matchesTool } from './hooks-matchers.js';

export interface ExecuteChainOptions {
  readonly hookName: string;
  readonly throwOnHandlerError: boolean;
  readonly toolName?: string | undefined;
}

/**
 * Execute a chain of hook handlers sequentially.
 *
 * Supports:
 * - ToolMatcher and filter-based skipping
 * - Sync results collected into `results`
 * - Async fire-and-forget via `{ async: true }` return
 * - Mutation piping (mutatedInput -> toolInput, mutatedPrompt -> prompt)
 * - Short-circuit on block/reject fields
 */
export async function executeHandlerChain<P, R>(
  entries: ReadonlyArray<HookEntry<P, R>>,
  initialPayload: P,
  context: HookContext,
  options: ExecuteChainOptions,
): Promise<EmitResult<R, P>> {
  const results: R[] = [];
  const pending: Promise<void>[] = [];
  let currentPayload = { ...initialPayload } as P;
  let blocked = false;

  const blockField = BLOCK_FIELDS[options.hookName];
  const canBlock = BLOCK_HOOKS.has(options.hookName);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;

    // Matcher check for tool-scoped hooks
    if (
      entry.matcher !== undefined &&
      options.toolName !== undefined &&
      !matchesTool(entry.matcher, options.toolName)
    ) {
      continue;
    }

    // Filter check
    if (entry.filter && !entry.filter(currentPayload)) {
      continue;
    }

    try {
      const returnValue = await entry.handler(currentPayload, context);

      // Async fire-and-forget
      if (isAsyncOutput(returnValue)) {
        const asyncOutput = returnValue as AsyncOutput;
        const timeout = asyncOutput.asyncTimeout ?? DEFAULT_ASYNC_TIMEOUT;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const asyncPromise = Promise.resolve().then(() => {
          clearTimeout(timeoutId);
        });
        pending.push(asyncPromise);
        continue;
      }

      // Void / undefined -- side-effect only, continue
      if (returnValue === undefined || returnValue === null) {
        continue;
      }

      const result = returnValue as R;
      results.push(result);

      // Apply mutation piping
      currentPayload = applyMutations(currentPayload, result);

      // Short-circuit on block
      if (canBlock && blockField && isBlockTriggered(result, blockField)) {
        blocked = true;
        break;
      }
    } catch (error) {
      if (options.throwOnHandlerError) {
        throw error;
      }
      console.warn(
        `[HooksManager] Handler ${i} for hook "${options.hookName}" threw:`,
        error,
      );
    }
  }

  return { results, pending, finalPayload: currentPayload, blocked };
}

/**
 * Apply mutation fields from a result onto the current payload.
 */
function applyMutations<P, R>(payload: P, result: R): P {
  if (typeof result !== 'object' || result === null) {
    return payload;
  }

  let mutated = payload;
  for (const [resultField, payloadField] of Object.entries(MUTATION_FIELD_MAP)) {
    if (resultField in result) {
      const value = (result as Record<string, unknown>)[resultField];
      if (value !== undefined) {
        mutated = { ...mutated, [payloadField]: value };
      }
    }
  }
  return mutated;
}

/**
 * Check if a result triggers a short-circuit block.
 */
function isBlockTriggered<R>(result: R, blockField: string): boolean {
  if (typeof result !== 'object' || result === null) {
    return false;
  }
  const value = (result as Record<string, unknown>)[blockField];
  return value === true || typeof value === 'string';
}

/**
 * Tool-level retry: wrap a tool so its `execute` function is automatically
 * re-run when it throws. This absorbs transient failures (e.g. a flaky
 * network call inside the tool) before they reach the model — without the
 * wrapper, a throwing tool is reported to the model as an error result,
 * which burns a full provider round trip while the model decides to re-try.
 *
 * The SDK stays unopinionated about tool errors by default; retry is the
 * tool author's policy, opted into per tool:
 *
 * ```typescript
 * const fetchTool = withToolRetry(
 *   tool({
 *     name: 'web_fetch',
 *     // ...
 *     execute: async ({ url }) => fetchPage(url),
 *   }),
 *   { limit: 2, onRetry: ({ toolName, attempt, error }) => log(...) },
 * );
 * ```
 *
 * Notes:
 * - Only wrap tools whose `execute` is safe to re-run (idempotent or
 *   side-effect free). Do not wrap tools like `send_email`.
 * - Generator tools are re-run from the start on retry; preliminary results
 *   already emitted by the failed attempt will have been forwarded to
 *   consumers and may repeat.
 * - HITL `onToolCalled` hooks and manual tools are not retried; the tool is
 *   returned unchanged if it has no `execute` function.
 */

import type { Tool } from './tool-types.js';
import { resolveBackoffMs, sleep } from './turn-retry.js';

/**
 * Context passed to `isRetryable` / `onRetry` when a tool execution fails.
 */
export interface ToolRetryContext {
  /** Name of the tool whose execution failed. */
  toolName: string;
  /** The retry attempt about to be made (1 = first retry). */
  attempt: number;
  /** The error thrown by the failed attempt. */
  error: unknown;
}

/**
 * Options for `withToolRetry`.
 */
export interface ToolRetryOptions {
  /**
   * Maximum number of retries (not counting the initial attempt).
   * Default: 2.
   */
  limit?: number;
  /**
   * Delay before each retry attempt, in milliseconds. A function receives
   * the attempt number (1 = first retry). Default: 0.
   */
  backoffMs?: number | ((attempt: number) => number);
  /**
   * Decide whether a thrown error should be retried. Default: retry all
   * errors (the wrapper only sees `execute` throws; input validation
   * happens before it and is never retried).
   */
  isRetryable?: (context: ToolRetryContext) => boolean | Promise<boolean>;
  /**
   * Observability hook invoked before each retry attempt.
   */
  onRetry?: (context: ToolRetryContext) => void | Promise<void>;
}

/**
 * Decide whether a failure should be retried and run the retry hooks.
 * Returns true when the caller should re-attempt.
 */
async function shouldRetry(
  options: ToolRetryOptions | undefined,
  context: ToolRetryContext,
): Promise<boolean> {
  const limit = options?.limit ?? 2;
  if (context.attempt > limit) {
    return false;
  }
  if (options?.isRetryable && !(await options.isRetryable(context))) {
    return false;
  }
  await options?.onRetry?.(context);
  const backoff = resolveBackoffMs(options?.backoffMs, context.attempt);
  if (backoff > 0) {
    await sleep(backoff);
  }
  return true;
}

/**
 * Wrap a tool so its `execute` function is automatically re-run (up to
 * `limit` times) when it throws. Regular async tools and generator tools
 * are both supported; tools without an `execute` function are returned
 * unchanged. The tool's type — including its schemas and inferred
 * input/output types — is preserved.
 */
export function withToolRetry<TTool extends Tool>(tool: TTool, options?: ToolRetryOptions): TTool {
  const fn = (
    tool as {
      function?: {
        name?: string;
        execute?: unknown;
      };
    }
  ).function;
  if (!fn || typeof fn.execute !== 'function') {
    return tool;
  }

  const toolName = fn.name ?? 'unknown';
  const originalExecute = fn.execute as (...args: unknown[]) => unknown;
  // Match the SDK's own discriminator (isGeneratorTool): a tool is a
  // generator tool iff its function declares an eventSchema. The executor
  // drives generator tools via iterator.next(), so the wrapper must also be
  // an async generator in that case.
  const isGenerator = 'eventSchema' in fn;

  let wrappedExecute: (...args: unknown[]) => unknown;

  if (isGenerator) {
    // Generator tool: a failed attempt is re-run from the start. Yields from
    // the failed attempt have already been forwarded.
    wrappedExecute = async function* retryingGeneratorExecute(...args: unknown[]) {
      let attempt = 0;
      while (true) {
        try {
          const iterator = originalExecute(...args) as AsyncGenerator<unknown, unknown, unknown>;
          let step = await iterator.next();
          while (!step.done) {
            yield step.value;
            step = await iterator.next();
          }
          return step.value;
        } catch (error) {
          attempt++;
          const retry = await shouldRetry(options, {
            toolName,
            attempt,
            error,
          });
          if (!retry) {
            throw error;
          }
        }
      }
    };
  } else {
    wrappedExecute = async function retryingExecute(...args: unknown[]) {
      let attempt = 0;
      while (true) {
        try {
          return await originalExecute(...args);
        } catch (error) {
          attempt++;
          const retry = await shouldRetry(options, {
            toolName,
            attempt,
            error,
          });
          if (!retry) {
            throw error;
          }
        }
      }
    };
  }

  return {
    ...tool,
    function: {
      ...fn,
      execute: wrappedExecute,
    },
  } as TTool;
}

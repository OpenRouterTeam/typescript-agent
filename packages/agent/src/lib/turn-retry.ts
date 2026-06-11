/**
 * Turn-level retry support for the callModel tool loop.
 *
 * A "turn" is one provider request + stream consumption. The conversation
 * state accumulated across turns (tool results, prior outputs) lives on the
 * ModelResult instance, so a failed turn can be re-sent without losing any
 * gathered context. This module holds the public option types, the typed
 * errors that classify turn failures, the default retryability policy, and
 * the idle-timeout iterator that converts silently-hung streams into
 * retryable failures.
 */

/**
 * Context passed to `isRetryable` when deciding whether to retry a failed turn.
 */
export interface TurnRetryContext {
  /** The turn that failed (0 = initial request). */
  turnNumber: number;
  /** The retry attempt about to be made (1 = first retry). */
  attempt: number;
}

/**
 * Options for turn-level retry in the callModel tool loop.
 *
 * When a turn's provider request or stream fails, the turn is re-sent with
 * the full accumulated conversation intact — tool results gathered in prior
 * turns are never discarded. Without this option a single dead turn aborts
 * the entire loop.
 *
 * Mid-turn retries emit a `turn.retry` event on the unified stream
 * (`getFullResponsesStream`). Events received from the failed attempt before
 * the failure remain in the stream; consumers that care about exact turn
 * contents should treat events between `turn.start`/`turn.retry` and a
 * subsequent `turn.retry` as void.
 */
export interface RetryTurnOptions {
  /**
   * Maximum number of retries per turn (not counting the initial attempt).
   * Default: 2.
   */
  limit?: number;
  /**
   * If no stream event arrives for this many milliseconds during a turn, the
   * turn fails with a retryable `TurnIdleTimeoutError` and the underlying
   * stream is cancelled. This is what converts silently-hung provider
   * streams (no terminal event, connection left open) into recoverable
   * failures. Default: no idle timeout.
   */
  idleTimeoutMs?: number;
  /**
   * Delay before each retry attempt, in milliseconds. A function receives
   * the attempt number (1 = first retry). Default: 0 (the provider round
   * trip itself dominates latency).
   */
  backoffMs?: number | ((attempt: number) => number);
  /**
   * Decide whether a failed turn should be retried. Defaults to
   * `defaultIsTurnRetryable`: retries idle timeouts, streams that ended
   * without a terminal event, network errors, and HTTP 408/429/5xx; does not
   * retry `response.failed` events (e.g. refusals) or other HTTP 4xx.
   */
  isRetryable?: (error: Error, context: TurnRetryContext) => boolean | Promise<boolean>;
}

/**
 * Thrown when a turn's stream produced no events for `idleTimeoutMs`
 * milliseconds. Retryable by default.
 */
export class TurnIdleTimeoutError extends Error {
  readonly turnNumber: number;
  readonly idleTimeoutMs: number;

  constructor(turnNumber: number, idleTimeoutMs: number) {
    super(
      `Turn ${turnNumber} stream produced no events for ${idleTimeoutMs}ms (idle timeout exceeded)`,
    );
    this.name = 'TurnIdleTimeoutError';
    this.turnNumber = turnNumber;
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

/**
 * Thrown when a turn's stream closed without a terminal event
 * (`response.completed` / `response.incomplete`). This is the signature of
 * an upstream stream dying mid-flight. Retryable by default.
 */
export class TurnStreamEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnStreamEndedError';
  }
}

/**
 * Thrown when a turn's stream emitted a terminal `response.failed` event.
 * The provider deliberately failed the response (which includes refusals),
 * so this is NOT retryable by default — opt in via `isRetryable` if your
 * gateway emits transient failures this way.
 */
export class TurnResponseFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnResponseFailedError';
  }
}

/**
 * Best-effort extraction of an HTTP status code from SDK / fetch errors.
 */
function statusCodeOf(error: Error): number | undefined {
  const candidate = error as Error & {
    statusCode?: unknown;
    status?: unknown;
    httpMeta?: {
      response?: {
        status?: unknown;
      };
    };
  };
  for (const value of [
    candidate.statusCode,
    candidate.status,
    candidate.httpMeta?.response?.status,
  ]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

/**
 * Default turn retryability policy:
 * - `TurnIdleTimeoutError` / `TurnStreamEndedError` — retry (dead/hung stream)
 * - `TurnResponseFailedError` — don't retry (deliberate provider failure,
 *   e.g. a refusal; retrying re-asks a deterministic question)
 * - HTTP errors — retry 408, 429, and 5xx; don't retry other 4xx
 * - anything else (network/socket errors surfaced by the fetch layer) — retry
 */
export function defaultIsTurnRetryable(error: Error): boolean {
  if (error instanceof TurnIdleTimeoutError || error instanceof TurnStreamEndedError) {
    return true;
  }
  if (error instanceof TurnResponseFailedError) {
    return false;
  }
  const status = statusCodeOf(error);
  if (status !== undefined) {
    return status === 408 || status === 429 || status >= 500;
  }
  return true;
}

/**
 * Resolve the backoff delay for a retry attempt.
 */
export function resolveBackoffMs(
  backoffMs: RetryTurnOptions['backoffMs'],
  attempt: number,
): number {
  if (typeof backoffMs === 'function') {
    return backoffMs(attempt);
  }
  return backoffMs ?? 0;
}

/**
 * Wrap an async iterator so that a gap of more than `idleTimeoutMs` between
 * events fails the iteration with the error produced by `makeTimeoutError`.
 *
 * The caller is responsible for cancelling the underlying stream when the
 * timeout fires — the wrapped iterator's pending `next()` is abandoned (its
 * eventual settlement is swallowed to avoid unhandled rejections).
 */
export async function* iterateWithIdleTimeout<T>(
  iterator: AsyncIterableIterator<T>,
  idleTimeoutMs: number | undefined,
  makeTimeoutError: () => Error,
): AsyncIterableIterator<T> {
  if (!idleTimeoutMs || idleTimeoutMs <= 0) {
    yield* iterator;
    return;
  }

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const nextPromise = iterator.next();
    // If the timeout wins the race, nobody awaits this promise anymore —
    // swallow its eventual rejection so it can't surface as unhandled.
    nextPromise.catch(() => {});
    try {
      const result = await Promise.race([
        nextPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(makeTimeoutError()), idleTimeoutMs);
        }),
      ]);
      if (result.done) {
        return;
      }
      yield result.value;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * Promise-based sleep used between retry attempts.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

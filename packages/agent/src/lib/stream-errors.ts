import type * as models from '@openrouter/sdk/models';

/**
 * Typed stream errors (DEV-723).
 *
 * - {@link StreamStalledError}: the client-side stream watchdog
 *   (`stream-watchdog.ts`) fired because a response stream stayed open
 *   without producing content within a configured deadline.
 * - {@link StreamFailedError}: the server reported a failure mid-stream
 *   (`response.failed`, a stream-level `error` event) or the stream ended
 *   without any terminal event.
 *
 * Both replace bare `Error`s so callers can branch on `instanceof` and on
 * the `retryable` hint instead of string-matching messages. Message text is
 * informational, not a contract.
 *
 * This module only has type imports from `@openrouter/sdk`, so it is safe to
 * load from startup-sensitive code paths.
 */

/**
 * Which watchdog deadline expired.
 *
 * - `first_content`: the response stream started (headers received) but no
 *   content-bearing event arrived within `firstContentMs`.
 * - `between_content`: content started flowing, but the gap since the last
 *   content-bearing event exceeded `contentIntervalMs`.
 */
export type StreamStallPhase = 'first_content' | 'between_content';

/**
 * Raised when a streaming response stalls: the connection stays open (and
 * may still receive keep-alive framing or metadata events) but no
 * content-bearing event arrives within the configured deadline.
 */
export class StreamStalledError extends Error {
  override readonly name = 'StreamStalledError';

  /** Which deadline expired. */
  readonly phase: StreamStallPhase;
  /** The configured deadline that expired, in milliseconds. */
  readonly timeoutMs: number;
  /**
   * Milliseconds elapsed since the deadline was armed (stream start for
   * `first_content`, the last content-bearing event for `between_content`).
   */
  readonly elapsedMs: number;
  /** Whether any content-bearing event was received before the stall. */
  readonly receivedAnyContent: boolean;

  constructor(options: {
    phase: StreamStallPhase;
    timeoutMs: number;
    elapsedMs: number;
    receivedAnyContent: boolean;
  }) {
    const message =
      options.phase === 'first_content'
        ? `Stream stalled: no content received within ${options.timeoutMs}ms of the response stream starting`
        : `Stream stalled: no content received for ${options.timeoutMs}ms after the last content event`;
    super(message);
    this.phase = options.phase;
    this.timeoutMs = options.timeoutMs;
    this.elapsedMs = options.elapsedMs;
    this.receivedAnyContent = options.receivedAnyContent;
    Object.setPrototypeOf(this, StreamStalledError.prototype);
  }

  /**
   * Whether re-issuing the request cannot duplicate output: true only when
   * the stall happened before any content was received.
   */
  get retryable(): boolean {
    return !this.receivedAnyContent;
  }
}

/**
 * Where a {@link StreamFailedError} came from.
 *
 * - `response_failed`: a `response.failed` event (carries the failed response).
 * - `error_event`: a stream-level `error` event, followed by the stream ending
 *   without a completion.
 * - `truncated`: the stream ended with no terminal event and no error event
 *   (the connection closed mid-response).
 */
export type StreamFailureKind = 'response_failed' | 'error_event' | 'truncated';

/**
 * Error codes that indicate a transient condition where retrying the request
 * (ideally with backoff) is reasonable. Covers the Responses error-field codes
 * (`server_error`, ...) and canonical OpenRouter error types
 * (`provider_overloaded`, ...).
 */
const TRANSIENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'server_error',
  'server',
  'timeout',
  'rate_limit_exceeded',
  'provider_overloaded',
  'provider_unavailable',
]);

/**
 * Raised when a response stream fails: the server reported a failure
 * (`response.failed` or a stream-level `error` event) or the stream ended
 * without any terminal event.
 */
export class StreamFailedError extends Error {
  override readonly name = 'StreamFailedError';

  /** Where the failure came from. */
  readonly kind: StreamFailureKind;
  /** Provider/API error code (e.g. `server_error`), when reported. */
  readonly code: string | null;
  /**
   * Canonical OpenRouter error type (e.g. `provider_unavailable`), when the
   * failed response carries one.
   */
  readonly errorType: string | null;
  /** The failed response, when the failure came from `response.failed`. */
  readonly response: models.OpenResponsesResult | null;

  constructor(options: {
    kind: StreamFailureKind;
    message: string;
    code?: string | null | undefined;
    errorType?: string | null | undefined;
    response?: models.OpenResponsesResult | null | undefined;
  }) {
    super(options.message);
    this.kind = options.kind;
    this.code = options.code ?? null;
    this.errorType = options.errorType ?? null;
    this.response = options.response ?? null;
    Object.setPrototypeOf(this, StreamFailedError.prototype);
  }

  /**
   * Whether the failure looks transient (server error, timeout, rate limit,
   * provider overloaded/unavailable), so a retry with backoff is reasonable.
   * Validation-style failures and truncated streams return false: a truncated
   * stream may already have delivered partial output.
   */
  get retryable(): boolean {
    return (
      (this.code !== null && TRANSIENT_FAILURE_CODES.has(this.code)) ||
      (this.errorType !== null && TRANSIENT_FAILURE_CODES.has(this.errorType))
    );
  }

  /** Build from a `response.failed` event's response payload. */
  static fromFailedResponse(response: models.OpenResponsesResult): StreamFailedError {
    const code = typeof response.error?.code === 'string' ? response.error.code : null;
    // Not modelled by every SDK version: read defensively.
    const rawErrorType = (
      response as {
        errorType?: unknown;
      }
    ).errorType;
    const errorType = typeof rawErrorType === 'string' ? rawErrorType : null;
    const detail = response.error?.message ?? 'no error detail provided';
    return new StreamFailedError({
      kind: 'response_failed',
      message: `Response failed${code ? ` (${code})` : ''}: ${detail}`,
      code,
      errorType,
      response,
    });
  }

  /** Build from a stream-level `error` event. */
  static fromErrorEvent(event: { code: string | null; message: string }): StreamFailedError {
    return new StreamFailedError({
      kind: 'error_event',
      message: `Stream error${event.code ? ` (${event.code})` : ''}: ${event.message}`,
      code: event.code,
    });
  }

  /**
   * Build for a stream that ended without a terminal event. Uses the most
   * recent stream-level `error` event as the cause when one was seen.
   */
  static fromStreamEnd(
    errorEvent:
      | {
          code: string | null;
          message: string;
        }
      | null
      | undefined,
    message = 'Stream ended without completion event',
  ): StreamFailedError {
    if (errorEvent) {
      return StreamFailedError.fromErrorEvent(errorEvent);
    }
    return new StreamFailedError({
      kind: 'truncated',
      message,
    });
  }
}

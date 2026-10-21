import type * as models from '@openrouter/sdk/models';
import type { StreamStallPhase } from './stream-errors.js';
import { StreamStalledError } from './stream-errors.js';

/**
 * Client-side stalled-stream detection (DEV-723).
 *
 * A streaming response can return headers quickly, emit only keep-alive
 * framing or metadata events, and then stall indefinitely without producing
 * content. Transport timeouts cannot catch this: SSE keep-alive comments
 * reset socket idle timers even though no content is flowing.
 *
 * The watchdog wraps a parsed event stream and enforces two opt-in semantic
 * deadlines:
 *
 * - `firstContentMs`: armed when the stream starts; satisfied (and
 *   permanently disarmed) by the first content-bearing event.
 * - `contentIntervalMs`: once content has started, the maximum gap allowed
 *   between content-bearing events.
 *
 * Classification follows the parsed event type, not transport activity:
 * empty role preludes (`response.output_item.added` for message shells),
 * status events (`response.created`, `response.in_progress`, ...), and SSE
 * keep-alive comments (dropped by the SSE parser before events reach this
 * layer) neither satisfy nor reset a deadline.
 *
 * When a deadline expires the wrapped stream errors with
 * {@link StreamStalledError} and the source stream is cancelled.
 */

/**
 * Opt-in stream stall deadlines. Both are unset by default (no watchdog).
 * Non-finite or non-positive values disable the corresponding deadline.
 */
export type StreamTimeoutOptions = {
  /**
   * Maximum milliseconds between the response stream starting (headers
   * received) and the first content-bearing event.
   */
  firstContentMs?: number | undefined;
  /**
   * Maximum milliseconds between consecutive content-bearing events once
   * content has started. Does not cover the pre-first-content window; that
   * is `firstContentMs`.
   */
  contentIntervalMs?: number | undefined;
};

/** Event classification and lifecycle hooks for {@link applyStreamWatchdog}. */
export type StreamWatchdogHooks<T> = {
  /**
   * True when the event carries model output (or a completed sub-result).
   * Content events satisfy and re-arm deadlines.
   */
  isContentEvent: (event: T) => boolean;
  /**
   * True when the event carries the server's final verdict (completed /
   * failed / incomplete). Terminal events permanently disarm the watchdog
   * so trailing bookkeeping events are never treated as stalls.
   */
  isTerminalEvent?: ((event: T) => boolean) | undefined;
  /**
   * Invoked once, before the wrapped stream errors, when a deadline expires.
   * Used to abort the underlying HTTP request.
   */
  onStall?: ((error: StreamStalledError) => void) | undefined;
  /**
   * The request's abort signal. When it aborts, the watchdog disarms for
   * good: the abort reaches consumers through the source stream erroring,
   * and must never be reported as a stall.
   */
  signal?: AbortSignal | undefined;
};

/**
 * Wrap `source` with stall deadlines. Returns `source` unchanged when no
 * deadline is configured.
 *
 * The wrapper pumps eagerly (it does not propagate backpressure): deadlines
 * measure the server, not how fast the caller reads. Parsed SSE events are
 * small and downstream consumers buffer them regardless.
 */
export function applyStreamWatchdog<T>(
  source: ReadableStream<T>,
  timeouts: StreamTimeoutOptions,
  hooks: StreamWatchdogHooks<T>,
): ReadableStream<T> {
  const firstContentMs = normalizeTimeout(timeouts.firstContentMs);
  const contentIntervalMs = normalizeTimeout(timeouts.contentIntervalMs);
  if (firstContentMs === undefined && contentIntervalMs === undefined) {
    return source;
  }
  const reader = source.getReader();
  let watchdog: StreamWatchdog<T> | undefined;
  return new ReadableStream<T>({
    start(controller) {
      watchdog = new StreamWatchdog(reader, controller, hooks, firstContentMs, contentIntervalMs);
      void watchdog.pump();
    },
    cancel(reason) {
      watchdog?.settle();
      return reader.cancel(reason);
    },
  });
}

/** Deadline state for one watched stream. See {@link applyStreamWatchdog}. */
class StreamWatchdog<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private armedPhase: StreamStallPhase = 'first_content';
  private armedTimeoutMs = 0;
  private armedAtMs = 0;
  private receivedContent = false;
  /** Set by a terminal event or an abort: deadlines stop applying. */
  private disarmed = false;
  /** Set once the wrapped stream has closed, errored, stalled or been cancelled. */
  private settled = false;
  private readonly onAbort = (): void => {
    this.disarmed = true;
    this.clearTimer();
  };

  constructor(
    private readonly reader: ReadableStreamDefaultReader<T>,
    private readonly controller: ReadableStreamDefaultController<T>,
    private readonly hooks: StreamWatchdogHooks<T>,
    firstContentMs: number | undefined,
    private readonly contentIntervalMs: number | undefined,
  ) {
    const signal = hooks.signal;
    if (signal?.aborted) {
      this.disarmed = true;
      return;
    }
    signal?.addEventListener('abort', this.onAbort, {
      once: true,
    });
    // The pre-first-content deadline arms the moment the stream starts.
    if (firstContentMs !== undefined) {
      this.arm('first_content', firstContentMs);
    }
  }

  settle(): void {
    this.settled = true;
    this.clearTimer();
    this.hooks.signal?.removeEventListener('abort', this.onAbort);
  }

  async pump(): Promise<void> {
    try {
      while (true) {
        const result = await this.reader.read();
        if (this.settled) {
          return;
        }
        if (result.done) {
          this.settle();
          this.controller.close();
          return;
        }
        this.observe(result.value);
        this.controller.enqueue(result.value);
      }
    } catch (error) {
      if (!this.settled) {
        this.settle();
        this.controller.error(error);
      }
    }
  }

  private observe(event: T): void {
    if (this.hooks.isTerminalEvent?.(event)) {
      this.disarmed = true;
      this.clearTimer();
      return;
    }
    if (this.disarmed || !this.hooks.isContentEvent(event)) {
      return;
    }
    this.receivedContent = true;
    if (this.contentIntervalMs !== undefined) {
      this.arm('between_content', this.contentIntervalMs);
    } else {
      this.clearTimer();
    }
  }

  private arm(phase: StreamStallPhase, timeoutMs: number): void {
    this.clearTimer();
    this.armedPhase = phase;
    this.armedTimeoutMs = timeoutMs;
    this.armedAtMs = Date.now();
    this.timer = setTimeout(() => this.expire(), timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private expire(): void {
    this.timer = undefined;
    if (this.settled || this.disarmed) {
      return;
    }
    this.settle();
    const error = new StreamStalledError({
      phase: this.armedPhase,
      timeoutMs: this.armedTimeoutMs,
      elapsedMs: Date.now() - this.armedAtMs,
      receivedAnyContent: this.receivedContent,
    });
    this.hooks.onStall?.(error);
    this.controller.error(error);
    // Resolves the pump's pending read; `settled` makes the pump bail
    // without touching the (already errored) controller.
    this.reader.cancel(error).catch(() => {
      // Irrelevant once the wrapped stream has errored.
    });
  }
}

/**
 * Response stream event types that carry model output or a completed
 * sub-result. These satisfy and re-arm watchdog deadlines.
 *
 * Deliberately excluded (neutral: neither satisfy nor reset):
 * - `response.created` / `response.in_progress`: status.
 * - `response.output_item.added`: an empty item shell (role prelude); the
 *   content it introduces arrives as subsequent delta events.
 * - `response.content_part.added` / `response.reasoning_summary_part.added`:
 *   part shells preceding their deltas.
 * - in-progress markers of server-side tools (web search, image generation,
 *   fusion): status, not output.
 * - `error`: a stream-level error is not output, and the stream may still
 *   recover and complete, so it must not disarm the watchdog either.
 * - unknown event types: a stream of only unknown types is indistinguishable
 *   from a stall; mixed streams are kept alive by the known events.
 */
const CONTENT_BEARING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'response.output_text.delta',
  'response.output_text.done',
  'response.output_text.annotation.added',
  'response.refusal.delta',
  'response.refusal.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_summary_part.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done',
  'response.apply_patch_call_operation_diff.delta',
  'response.apply_patch_call_operation_diff.done',
  'response.content_part.done',
  'response.output_item.done',
  'response.web_search_call.completed',
  'response.image_generation_call.partial_image',
  'response.image_generation_call.completed',
  'response.fusion_call.panel.delta',
  'response.fusion_call.panel.reasoning.delta',
  'response.fusion_call.panel.completed',
  'response.fusion_call.panel.failed',
  'response.fusion_call.analysis.completed',
  'response.fusion_call.completed',
]);

/**
 * Event types carrying the server's final verdict. They disarm the watchdog
 * permanently. `error` is NOT terminal: the stream can continue (and even
 * complete) after a stream-level error event, so the watchdog keeps
 * policing it; otherwise an `error` followed by silence would hang forever.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
]);

function eventType(event: models.StreamEvents): string | undefined {
  return 'type' in event && typeof event.type === 'string' ? event.type : undefined;
}

/**
 * True when the event carries model output (text / refusal / reasoning
 * deltas, tool-call arguments, completed output items or sub-results).
 */
export function isContentBearingStreamEvent(event: models.StreamEvents): boolean {
  const type = eventType(event);
  return type !== undefined && CONTENT_BEARING_EVENT_TYPES.has(type);
}

/** True for `response.completed`, `response.failed` and `response.incomplete`. */
export function isTerminalStreamEvent(event: models.StreamEvents): boolean {
  const type = eventType(event);
  return type !== undefined && TERMINAL_EVENT_TYPES.has(type);
}

/**
 * {@link applyStreamWatchdog} for Responses event streams, with the standard
 * event classification.
 */
export function applyResponsesStreamWatchdog(
  source: ReadableStream<models.StreamEvents>,
  timeouts: StreamTimeoutOptions,
  hooks?: Pick<StreamWatchdogHooks<models.StreamEvents>, 'onStall' | 'signal'>,
): ReadableStream<models.StreamEvents> {
  return applyStreamWatchdog(source, timeouts, {
    isContentEvent: isContentBearingStreamEvent,
    isTerminalEvent: isTerminalStreamEvent,
    onStall: hooks?.onStall,
    signal: hooks?.signal,
  });
}

/** True when at least one deadline is enabled (set, finite, > 0). */
export function hasActiveStreamTimeouts(timeouts: StreamTimeoutOptions | undefined): boolean {
  if (!timeouts) {
    return false;
  }
  return (
    normalizeTimeout(timeouts.firstContentMs) !== undefined ||
    normalizeTimeout(timeouts.contentIntervalMs) !== undefined
  );
}

/**
 * Treat non-finite and non-positive values as disabled so callers can pass
 * raw user input without pre-validating.
 */
export function normalizeTimeout(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

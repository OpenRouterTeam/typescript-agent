import type * as models from '@openrouter/sdk/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamStalledError } from '../../src/lib/stream-errors.js';
import {
  applyResponsesStreamWatchdog,
  applyStreamWatchdog,
  hasActiveStreamTimeouts,
  isContentBearingStreamEvent,
  isTerminalStreamEvent,
} from '../../src/lib/stream-watchdog.js';
import {
  completedEvent,
  controlledStream,
  createdEvent,
  emptyMessageShell,
  errorEvent,
  failedEvent,
  functionCallArgsDelta,
  reasoningDelta,
  textDelta,
  textResponse,
} from '../utils/stream-fixtures.js';

/**
 * Read a stream in the background, recording every event and how it ended,
 * so fake-timer tests can advance the clock while a read is pending.
 */
function observe<T>(stream: ReadableStream<T>) {
  const events: T[] = [];
  const state: {
    status: 'open' | 'closed' | 'errored';
    error: unknown;
  } = {
    status: 'open',
    error: undefined,
  };
  const reader = stream.getReader();
  const readAll = async (): Promise<void> => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          state.status = 'closed';
          return;
        }
        events.push(result.value);
      }
    } catch (error) {
      state.status = 'errored';
      state.error = error;
    }
  };
  const done = readAll();
  return {
    events,
    state,
    done,
  };
}

const hooks = {
  isContentEvent: (e: string) => e.startsWith('content'),
  isTerminalEvent: (e: string) => e === 'terminal',
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('event classification', () => {
  it('classifies output deltas and completed sub-results as content', () => {
    expect(isContentBearingStreamEvent(textDelta('hi'))).toBe(true);
    expect(isContentBearingStreamEvent(reasoningDelta('hmm'))).toBe(true);
    expect(isContentBearingStreamEvent(functionCallArgsDelta('{'))).toBe(true);
    expect(
      isContentBearingStreamEvent({
        type: 'response.fusion_call.analysis.completed',
      } as unknown as models.StreamEvents),
    ).toBe(true);
  });

  it('treats status events, item shells, errors and unknown types as neutral', () => {
    expect(isContentBearingStreamEvent(createdEvent())).toBe(false);
    expect(isContentBearingStreamEvent(emptyMessageShell())).toBe(false);
    expect(isContentBearingStreamEvent(errorEvent('server_error', 'boom'))).toBe(false);
    expect(
      isContentBearingStreamEvent({
        type: 'response.mystery',
      } as unknown as models.StreamEvents),
    ).toBe(false);
    expect(isTerminalStreamEvent(createdEvent())).toBe(false);
    expect(isTerminalStreamEvent(textDelta('hi'))).toBe(false);
  });

  it('treats completed / failed / incomplete as terminal, but not error events', () => {
    expect(isTerminalStreamEvent(completedEvent(textResponse('x')))).toBe(true);
    expect(isTerminalStreamEvent(failedEvent('server_error', 'boom'))).toBe(true);
    expect(
      isTerminalStreamEvent({
        type: 'response.incomplete',
      } as unknown as models.StreamEvents),
    ).toBe(true);
    // An error event can be followed by more events (even a completion), so
    // it must keep the watchdog armed.
    expect(isTerminalStreamEvent(errorEvent('server_error', 'boom'))).toBe(false);
  });

  it('hasActiveStreamTimeouts ignores unset, zero, negative and non-finite values', () => {
    expect(hasActiveStreamTimeouts(undefined)).toBe(false);
    expect(hasActiveStreamTimeouts({})).toBe(false);
    expect(
      hasActiveStreamTimeouts({
        firstContentMs: 0,
        contentIntervalMs: -1,
      }),
    ).toBe(false);
    expect(
      hasActiveStreamTimeouts({
        firstContentMs: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
    expect(
      hasActiveStreamTimeouts({
        contentIntervalMs: 10,
      }),
    ).toBe(true);
  });
});

describe('applyStreamWatchdog', () => {
  it('returns the source unchanged when no deadline is configured', () => {
    for (const timeouts of [
      {},
      {
        firstContentMs: 0,
        contentIntervalMs: -5,
      },
      {
        firstContentMs: Number.NaN,
      },
    ]) {
      const source = controlledStream<string>().stream;
      expect(applyStreamWatchdog(source, timeouts, hooks)).toBe(source);
    }
  });

  it('passes a healthy stream through and leaves no timers behind', async () => {
    const source = controlledStream<string>();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 1000,
          contentIntervalMs: 1000,
        },
        hooks,
      ),
    );
    source.push('content-1');
    await vi.advanceTimersByTimeAsync(500);
    source.push('content-2');
    await vi.advanceTimersByTimeAsync(500);
    source.close();
    await out.done;
    expect(out.state.status).toBe('closed');
    expect(out.events).toEqual([
      'content-1',
      'content-2',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with first_content when no content arrives at all', async () => {
    const source = controlledStream<string>();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 40,
        },
        hooks,
      ),
    );
    await vi.advanceTimersByTimeAsync(39);
    expect(out.state.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1);
    await out.done;
    expect(out.state.status).toBe('errored');
    const stall = out.state.error as StreamStalledError;
    expect(stall).toBeInstanceOf(StreamStalledError);
    expect(stall.name).toBe('StreamStalledError');
    expect(stall.phase).toBe('first_content');
    expect(stall.timeoutMs).toBe(40);
    expect(stall.elapsedMs).toBe(40);
    expect(stall.receivedAnyContent).toBe(false);
    expect(stall.retryable).toBe(true);
  });

  it('metadata heartbeats neither satisfy nor extend the first_content deadline', async () => {
    const source = controlledStream<string>();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 90,
        },
        hooks,
      ),
    );
    for (let i = 0; i < 4; i++) {
      source.push('meta');
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(out.state.status).toBe('open');
    await vi.advanceTimersByTimeAsync(10);
    await out.done;
    // Non-content events still flow through to the consumer.
    expect(out.events).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
    ]);
    expect((out.state.error as StreamStalledError).phase).toBe('first_content');
  });

  it('the first content event disarms firstContentMs permanently', async () => {
    const source = controlledStream<string>();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 50,
        },
        hooks,
      ),
    );
    source.push('content-1');
    await vi.advanceTimersByTimeAsync(10_000);
    source.push('content-2');
    source.close();
    await out.done;
    expect(out.state.status).toBe('closed');
    expect(out.events).toEqual([
      'content-1',
      'content-2',
    ]);
  });

  it('fails with between_content when the stream stalls mid-generation', async () => {
    const source = controlledStream<string>();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 200,
          contentIntervalMs: 50,
        },
        hooks,
      ),
    );
    source.push('content-1');
    await vi.advanceTimersByTimeAsync(10);
    source.push('content-2');
    await vi.advanceTimersByTimeAsync(50);
    await out.done;
    expect(out.events).toEqual([
      'content-1',
      'content-2',
    ]);
    const stall = out.state.error as StreamStalledError;
    expect(stall.phase).toBe('between_content');
    expect(stall.timeoutMs).toBe(50);
    expect(stall.receivedAnyContent).toBe(true);
    // Content already flowed: not safe to blind-retry.
    expect(stall.retryable).toBe(false);
  });

  it('each content event re-arms the between_content deadline', async () => {
    const source = controlledStream<string>();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          contentIntervalMs: 50,
        },
        hooks,
      ),
    );
    for (let i = 0; i < 5; i++) {
      source.push(`content-${i}`);
      await vi.advanceTimersByTimeAsync(40);
    }
    source.close();
    await out.done;
    expect(out.state.status).toBe('closed');
    expect(out.events).toHaveLength(5);
  });

  it('contentIntervalMs alone does not police the pre-first-content window', async () => {
    const source = controlledStream<string>();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          contentIntervalMs: 30,
        },
        hooks,
      ),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    source.push('content-1');
    source.close();
    await out.done;
    expect(out.state.status).toBe('closed');
  });

  it('a terminal event disarms deadlines so trailing events are never stalls', async () => {
    const source = controlledStream<string>();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 50,
          contentIntervalMs: 30,
        },
        hooks,
      ),
    );
    source.push('content-1', 'terminal');
    await vi.advanceTimersByTimeAsync(1_000);
    source.push('meta-trailer');
    source.close();
    await out.done;
    expect(out.state.status).toBe('closed');
    expect(out.events).toEqual([
      'content-1',
      'terminal',
      'meta-trailer',
    ]);
  });

  it('cancels the source and calls onStall exactly once when a deadline expires', async () => {
    const source = controlledStream<string>();
    const onStall = vi.fn();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 30,
        },
        {
          ...hooks,
          onStall,
        },
      ),
    );
    await vi.advanceTimersByTimeAsync(30);
    await out.done;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]?.[0]).toBe(out.state.error);
    expect(source.cancelled).toBe(true);
    expect(source.cancelReason).toBe(out.state.error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates upstream errors as-is, not as stalls', async () => {
    const source = controlledStream<string>();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 1000,
        },
        hooks,
      ),
    );
    const upstream = new Error('upstream exploded');
    source.error(upstream);
    await out.done;
    expect(out.state.error).toBe(upstream);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelling the wrapped stream stops timers and cancels the source', async () => {
    const source = controlledStream<string>();
    const wrapped = applyStreamWatchdog(
      source.stream,
      {
        firstContentMs: 30,
      },
      hooks,
    );
    await wrapped.cancel('consumer walked away');
    expect(source.cancelled).toBe(true);
    expect(source.cancelReason).toBe('consumer walked away');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an abort on the request signal disarms the watchdog (aborts are never stalls)', async () => {
    const source = controlledStream<string>();
    const controller = new AbortController();
    const onStall = vi.fn();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 30,
        },
        {
          ...hooks,
          onStall,
          signal: controller.signal,
        },
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    const reason = new Error('user cancelled');
    controller.abort(reason);
    expect(vi.getTimerCount()).toBe(0);
    // The transport surfaces the abort by erroring the body stream.
    source.error(reason);
    await out.done;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.state.error).toBe(reason);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('an already-aborted signal never arms a deadline', async () => {
    const source = controlledStream<string>();
    const controller = new AbortController();
    controller.abort();
    const out = observe(
      applyStreamWatchdog(
        source.stream,
        {
          firstContentMs: 30,
        },
        {
          ...hooks,
          signal: controller.signal,
        },
      ),
    );
    expect(vi.getTimerCount()).toBe(0);
    source.close();
    await out.done;
    expect(out.state.status).toBe('closed');
  });
});

describe('applyResponsesStreamWatchdog', () => {
  it('stalls on the keep-alive pathology: created + role prelude, then silence', async () => {
    const source = controlledStream();
    const out = observe(
      applyResponsesStreamWatchdog(source.stream, {
        firstContentMs: 60,
      }),
    );
    source.push(createdEvent(), emptyMessageShell());
    await vi.advanceTimersByTimeAsync(60);
    await out.done;
    expect(out.events).toHaveLength(2);
    const stall = out.state.error as StreamStalledError;
    expect(stall).toBeInstanceOf(StreamStalledError);
    expect(stall.phase).toBe('first_content');
    expect(stall.retryable).toBe(true);
  });

  it('reasoning deltas satisfy the first-content deadline', async () => {
    const source = controlledStream();
    const out = observe(
      applyResponsesStreamWatchdog(source.stream, {
        firstContentMs: 50,
      }),
    );
    source.push(createdEvent());
    await vi.advanceTimersByTimeAsync(10);
    source.push(reasoningDelta('thinking...'));
    await vi.advanceTimersByTimeAsync(500);
    source.push(textDelta('answer'), completedEvent(textResponse('answer')));
    source.close();
    await out.done;
    expect(out.state.status).toBe('closed');
    expect(out.events).toHaveLength(4);
  });

  it('keeps policing after a stream-level error event (error then silence stalls)', async () => {
    const source = controlledStream();
    const out = observe(
      applyResponsesStreamWatchdog(source.stream, {
        firstContentMs: 50,
      }),
    );
    source.push(createdEvent(), errorEvent('server_error', 'transient'));
    await vi.advanceTimersByTimeAsync(50);
    await out.done;
    expect(out.state.error).toBeInstanceOf(StreamStalledError);
  });

  it('response.failed disarms: the failure surfaces through its own error path', async () => {
    const source = controlledStream();
    const out = observe(
      applyResponsesStreamWatchdog(source.stream, {
        firstContentMs: 50,
      }),
    );
    source.push(createdEvent(), failedEvent('server_error', 'boom'));
    await vi.advanceTimersByTimeAsync(1_000);
    source.close();
    await out.done;
    expect(out.state.status).toBe('closed');
  });
});
